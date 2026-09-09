import assert from "node:assert/strict";
import test from "node:test";
import type { Entry, Json } from "@skipruntime/core";
import { SkipUnknownResourceError } from "@skipruntime/core";
import type { FunctionReference } from "convex/server";
import {
  ConvexExternalService,
  type ConvexSubscriber,
} from "./convex_external_service.js";

type Row = { key: string; value: number };

const query = {} as FunctionReference<"query">;

/**
 * Stands in for ConvexClient. `push` replays what a Convex query subscription
 * delivers: a whole result set, once at subscribe time and again on every
 * change, including after a reconnect.
 */
class FakeConvex {
  push: (rows: Row[]) => void = () => {};
  fail: (error: Error) => void = () => {};
  subscriptions = 0;
  unsubscribed = 0;
  closed = 0;

  asSubscriber(): ConvexSubscriber {
    return {
      onUpdate: ((
        _query: unknown,
        _args: unknown,
        callback: (rows: Row[]) => unknown,
        onError?: (error: Error) => unknown,
      ) => {
        this.subscriptions += 1;
        this.push = (rows) => void callback(rows);
        this.fail = (error) => void onError?.(error);
        return () => {
          this.unsubscribed += 1;
        };
      }) as unknown as ConvexSubscriber["onUpdate"],
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    };
  }
}

/** Records what Skip was actually told, in order. */
function recorder() {
  const batches: { updates: Entry<Json, Json>[]; isInitial: boolean }[] = [];
  const errors: unknown[] = [];
  let reject = false;
  return {
    batches,
    errors,
    rejectNext: () => {
      reject = true;
    },
    callbacks: {
      update: (updates: Entry<Json, Json>[], isInitial: boolean) => {
        if (reject) {
          reject = false;
          return Promise.reject(new Error("Skip rejected the batch"));
        }
        batches.push({ updates, isInitial });
        return Promise.resolve();
      },
      error: (error: unknown) => {
        errors.push(error);
      },
    },
  };
}

function service(
  fake: FakeConvex,
  options: {
    closeClient?: boolean;
    maxResubscribeAttempts?: number;
    resubscribeBackoffMs?: number;
  } = {},
) {
  return new ConvexExternalService<Row>(
    fake.asSubscriber(),
    { rows: { query, args: {}, getKey: (row) => row.key } },
    options,
  );
}

/** Lets the queued delivery chain drain before assertions. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for the expected subscription state");
}

test("subscribe resolves once the initial snapshot is delivered", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const pending = service(fake, { resubscribeBackoffMs: 0 }).subscribe(
    "i1",
    "rows",
    {},
    sink.callbacks,
  );

  fake.push([{ key: "a", value: 1 }]);
  await pending;

  assert.equal(sink.batches.length, 1);
  assert.equal(sink.batches[0]!.isInitial, true);
  assert.deepEqual(sink.batches[0]!.updates, [["a", [{ key: "a", value: 1 }]]]);
});

test("subscribe rejects and cleans up when the initial delivery fails", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);

  fake.fail(new Error("connection refused"));
  await assert.rejects(pending, /connection refused/);

  // The subscription must not be left behind, or the instance id is burned.
  assert.equal(fake.unsubscribed, 1);

  // Proving it: the same instance id can be subscribed again and works.
  const retry = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await retry;
  assert.equal(sink.batches.at(-1)!.isInitial, true);
});

test("a rejected initial snapshot re-subscribes until Skip accepts it", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake, { resubscribeBackoffMs: 0 });
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);

  sink.rejectNext();
  fake.push([{ key: "a", value: 1 }]);
  await waitFor(() => fake.subscriptions === 2);

  assert.equal(fake.unsubscribed, 1, "should replace the failed bootstrap");

  fake.push([{ key: "a", value: 1 }]);
  await pending;

  assert.equal(sink.errors.length, 1);
  assert.deepEqual(sink.batches, [
    {
      updates: [["a", [{ key: "a", value: 1 }]]],
      isInitial: true,
    },
  ]);
});

test("a rejected update re-subscribes instead of waiting for a change", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const pending = service(fake, { resubscribeBackoffMs: 0 }).subscribe(
    "i1",
    "rows",
    {},
    sink.callbacks,
  );
  fake.push([{ key: "a", value: 1 }]);
  await pending;

  // Skip refuses this batch, so it never saw b. Convex will not re-deliver an
  // unchanged result, so waiting would leave the projection stale forever on a
  // dataset that goes quiet -- the adapter must tear down and re-establish.
  sink.rejectNext();
  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 2 },
  ]);
  await waitFor(() => fake.subscriptions === 2);

  assert.equal(sink.errors.length, 1);
  assert.equal(fake.unsubscribed, 1, "should have detached the subscription");

  // The re-established subscription delivers a full initial batch, so the rows
  // lost with the rejected batch are recovered without needing a data change.
  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 2 },
  ]);
  await settle();

  const last = sink.batches.at(-1)!;
  assert.equal(last.isInitial, true, "recovery batch replaces Skip's state");
  assert.deepEqual(
    new Map(last.updates),
    new Map([
      ["a", [{ key: "a", value: 1 }]],
      ["b", [{ key: "b", value: 2 }]],
    ]),
  );
});

test("a released instance drops deliveries queued behind teardown", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;
  const delivered = sink.batches.length;

  // Skip destroys the collection, then a queued Convex snapshot lands. Writing
  // it would throw into the error path on every clean teardown under load.
  convex.unsubscribe("i1");
  fake.push([{ key: "a", value: 2 }]);
  await settle();

  assert.equal(sink.batches.length, delivered, "no write after release");
  assert.deepEqual(sink.errors, [], "and no spurious error");
});

test("shutdown drains an in-flight delivery without closing an injected client", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;

  await convex.shutdown();

  assert.equal(fake.unsubscribed, 1);
  assert.equal(fake.closed, 0);
  assert.deepEqual(sink.errors, []);
});

test("shutdown closes an injected client only when requested", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake, { closeClient: true });
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await pending;

  await convex.shutdown();

  assert.equal(fake.closed, 1);
});

test("a reconnect snapshot re-diffs instead of replaying everything", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const pending = service(fake).subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 2 },
  ]);
  await pending;

  // Convex re-pushes the full result set after reconnecting; only the row that
  // actually changed should reach Skip, and never a second isInitial batch.
  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 9 },
  ]);
  await settle();

  const last = sink.batches.at(-1)!;
  assert.equal(last.isInitial, false);
  assert.deepEqual(last.updates, [["b", [{ key: "b", value: 9 }]]]);
  assert.equal(sink.batches.filter((b) => b.isInitial).length, 1);
});

test("deletions reach Skip as empty value lists", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const pending = service(fake).subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 2 },
  ]);
  await pending;

  fake.push([{ key: "a", value: 1 }]);
  await settle();

  assert.deepEqual(sink.batches.at(-1)!.updates, [["b", []]]);
});

test("an unknown resource name is reported as such", async () => {
  const fake = new FakeConvex();
  const sink = recorder();

  await assert.rejects(
    service(fake).subscribe("i1", "nope", {}, sink.callbacks),
    SkipUnknownResourceError,
  );
});

test("reusing an open instance id is refused", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await pending;

  await assert.rejects(
    convex.subscribe("i1", "rows", {}, sink.callbacks),
    /already open/,
  );
});

test("unsubscribe releases the Convex subscription once", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await pending;

  convex.unsubscribe("i1");
  assert.equal(fake.unsubscribed, 1);

  // Unsubscribing an unknown or already-released instance is a no-op.
  convex.unsubscribe("i1");
  convex.unsubscribe("never-existed");
  assert.equal(fake.unsubscribed, 1);
});

test("shutdown releases every subscription and closes the client", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake, { closeClient: true });
  const first = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await first;
  const second = convex.subscribe("i2", "rows", {}, sink.callbacks);
  fake.push([]);
  await second;

  await convex.shutdown();

  assert.equal(fake.unsubscribed, 2);
  assert.equal(fake.closed, 1);
});
