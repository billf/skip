import assert from "node:assert/strict";
import test from "node:test";
import type { Entry, Json } from "@skipruntime/core";
import { SkipUnknownResourceError } from "@skipruntime/core";
import type { FunctionReference } from "convex/server";
import {
  ConvexExternalService,
  defineConvexReactiveResource,
  diffSnapshot,
  type ConvexSubscriber,
} from "./index.js";

type Row = { key: string; value: number };
const query = {} as FunctionReference<"query">;

class FakeConvex {
  push: (rows: Row[]) => void = () => {};
  fail: (error: Error) => void = () => {};
  private readonly updateCallbacks: ((rows: Row[]) => unknown)[] = [];
  unsubscribed = 0;
  closed = 0;

  pushFromSubscription(subscription: number, rows: Row[]): void {
    void this.updateCallbacks[subscription]?.(rows);
  }

  asSubscriber(): ConvexSubscriber {
    return {
      onUpdate: ((
        _query: unknown,
        _args: unknown,
        callback: (rows: Row[]) => unknown,
        onError?: (error: Error) => unknown,
      ) => {
        this.updateCallbacks.push(callback);
        this.push = (rows) => { void callback(rows); };
        this.fail = (error) => { void onError?.(error); };
        return () => { this.unsubscribed += 1; };
      }) as ConvexSubscriber["onUpdate"],
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    };
  }
}

function recorder() {
  const batches: { updates: Entry<Json, Json>[]; isInitial: boolean }[] = [];
  const errors: unknown[] = [];
  let reject = false;
  return {
    batches,
    errors,
    rejectNext: () => { reject = true; },
    callbacks: {
      update: (updates: Entry<Json, Json>[], isInitial: boolean) => {
        if (reject) {
          reject = false;
          return Promise.reject(new Error("Skip rejected the batch"));
        }
        batches.push({ updates, isInitial });
        return Promise.resolve();
      },
      error: (error: unknown) => { errors.push(error); },
    },
  };
}

function service(
  fake: FakeConvex,
  argsFromParams = (params: Json) => {
    if (params !== null && typeof params === "object" && !Array.isArray(params)) {
      return {};
    }
    throw new TypeError("subscription parameters must be an object");
  },
) {
  return new ConvexExternalService<Row>(
    fake.asSubscriber(),
    {
      rows: defineConvexReactiveResource({
        query,
        getKey: (row: Row) => row.key,
        argsFromParams: (params, _scope) => argsFromParams(params),
      }),
    },
    {
      scope: { tenantId: "tenant-a" },
      logger: { error: () => {} },
    },
  );
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("diffSnapshot emits only inserts, changes, and deletions", () => {
  const initial = diffSnapshot(new Map(), [{ key: "a", value: 1 }], (row) => row.key);
  const changed = diffSnapshot(initial.next, [{ key: "b", value: 2 }], (row) => row.key);
  assert.deepEqual(new Map(changed.updates), new Map([
    ["b", [{ key: "b", value: 2 }]],
    ["a", []],
  ]));
});

test("diffSnapshot rejects duplicate keys and values outside Skip JSON", () => {
  assert.throws(
    () => diffSnapshot(new Map(), [{ key: "a", value: 1 }, { key: "a", value: 2 }], (row) => row.key),
    /Duplicate Convex snapshot key/,
  );
  assert.throws(
    () => diffSnapshot(new Map(), [{ key: "a", value: 1n } as unknown as Row], (row) => row.key),
    /bigint \(v\.int64\)/,
  );
});

test("subscription parameters are decoded before a Convex subscription starts", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake, () => { throw new TypeError("tenantId is configured, not a parameter"); });

  await assert.rejects(
    convex.subscribe("i1", "rows", { tenantId: "other" }, sink.callbacks),
    /tenantId is configured/,
  );
  assert.equal(fake.unsubscribed, 0);
  assert.equal(sink.errors.length, 1);
});

test("subscribe resolves once a full initial snapshot is accepted", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const pending = service(fake).subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;
  assert.deepEqual(sink.batches, [{ updates: [["a", [{ key: "a", value: 1 }]]], isInitial: true }]);
});

test("a rejected update establishes a new initial snapshot", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;

  sink.rejectNext();
  fake.push([{ key: "a", value: 1 }, { key: "b", value: 2 }]);
  await settle();
  assert.equal(fake.unsubscribed, 1);

  fake.push([{ key: "a", value: 1 }, { key: "b", value: 2 }]);
  await settle();
  assert.equal(sink.batches.at(-1)!.isInitial, true);
  assert.deepEqual(new Map(sink.batches.at(-1)!.updates), new Map([
    ["a", [{ key: "a", value: 1 }]],
    ["b", [{ key: "b", value: 2 }]],
  ]));
});

test("a queued delivery from a released subscription cannot overwrite recovery", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;

  sink.rejectNext();
  fake.push([{ key: "a", value: 1 }, { key: "b", value: 2 }]);
  await settle();

  fake.pushFromSubscription(0, [
    { key: "a", value: 1 },
    { key: "b", value: 2 },
    { key: "stale", value: 3 },
  ]);
  fake.push([{ key: "a", value: 1 }, { key: "b", value: 2 }]);
  await settle();

  assert.equal(sink.batches.length, 2);
  assert.equal(sink.batches.at(-1)!.isInitial, true);
  assert.deepEqual(new Map(sink.batches.at(-1)!.updates), new Map([
    ["a", [{ key: "a", value: 1 }]],
    ["b", [{ key: "b", value: 2 }]],
  ]));
});

test("a normal Convex reconnect re-diffs without claiming a new initial snapshot", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const pending = service(fake).subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }, { key: "b", value: 2 }]);
  await pending;
  fake.push([{ key: "a", value: 1 }, { key: "b", value: 3 }]);
  await settle();
  assert.deepEqual(sink.batches.at(-1), {
    updates: [["b", [{ key: "b", value: 3 }]]],
    isInitial: false,
  });
});

test("unknown resources and released instances do not leak subscriptions", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  await assert.rejects(convex.subscribe("i1", "missing", {}, sink.callbacks), SkipUnknownResourceError);

  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await pending;
  convex.unsubscribe("i1");
  fake.push([{ key: "a", value: 1 }]);
  await settle();
  assert.equal(fake.unsubscribed, 1);
  assert.equal(sink.batches.length, 1);
});

test("shutdown releases subscriptions and closes the Convex client", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await pending;
  await convex.shutdown();
  assert.equal(fake.unsubscribed, 1);
  assert.equal(fake.closed, 1);
});
