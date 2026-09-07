import assert from "node:assert/strict";
import test from "node:test";
import type { Entry, Json } from "@skipruntime/core";
import { SkipUnknownResourceError } from "@skipruntime/core";
import type { FunctionReference } from "convex/server";
import {
  ConvexExternalService,
  defineConvexReactiveResource,
  diffSnapshot,
  type ConvexExternalServiceOptions,
  type ConvexServiceScope,
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
  /** Zero-based attach numbers whose `onUpdate` call throws synchronously. */
  throwOnAttach = new Set<number>();
  private attaches = 0;

  get subscriptionCount(): number {
    return this.updateCallbacks.length;
  }

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
        if (this.throwOnAttach.has(this.attaches++)) {
          throw new Error("onUpdate threw");
        }
        this.updateCallbacks.push(callback);
        this.push = (rows) => {
          void callback(rows);
        };
        this.fail = (error) => {
          void onError?.(error);
        };
        // convex 1.45.0's unsubscribe throws when called twice, so the fake
        // does too: an adapter that detaches a subscription twice must fail here.
        let detached = false;
        return () => {
          if (detached) throw new Error("unsubscribe called twice");
          detached = true;
          this.unsubscribed += 1;
        };
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
  argsFromParams = (params: Json) => {
    if (
      params !== null &&
      typeof params === "object" &&
      !Array.isArray(params)
    ) {
      return {};
    }
    throw new TypeError("subscription parameters must be an object");
  },
  overrides: Partial<ConvexExternalServiceOptions> = {},
  onScope?: (scope: ConvexServiceScope) => void,
) {
  return new ConvexExternalService<Row>(
    fake.asSubscriber(),
    {
      rows: defineConvexReactiveResource({
        query,
        getKey: (row: Row) => row.key,
        argsFromParams: (params, scope) => {
          onScope?.(scope);
          return argsFromParams(params);
        },
      }),
    },
    {
      scope: { tenantId: "tenant-a" },
      logger: { error: () => {} },
      resubscribeBackoffMs: 1,
      ...overrides,
    },
  );
}

// Long enough for a backoff-delayed resubscribe to fire at the 1ms base delay
// these tests configure.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("diffSnapshot emits only inserts, changes, and deletions", () => {
  const initial = diffSnapshot(
    new Map(),
    [{ key: "a", value: 1 }],
    (row) => row.key,
  );
  const changed = diffSnapshot(
    initial.next,
    [{ key: "b", value: 2 }],
    (row) => row.key,
  );
  assert.deepEqual(
    new Map(changed.updates),
    new Map([
      ["b", [{ key: "b", value: 2 }]],
      ["a", []],
    ]),
  );
});

test("diffSnapshot rejects duplicate keys and values outside Skip JSON", () => {
  assert.throws(
    () =>
      diffSnapshot(
        new Map(),
        [
          { key: "a", value: 1 },
          { key: "a", value: 2 },
        ],
        (row) => row.key,
      ),
    /Duplicate Convex snapshot key/,
  );
  assert.throws(
    () =>
      diffSnapshot(
        new Map(),
        [{ key: "a", value: 1n } as unknown as Row],
        (row) => row.key,
      ),
    /bigint \(v\.int64\)/,
  );
  assert.throws(
    () =>
      diffSnapshot(
        new Map(),
        [{ key: "a", value: 1 }],
        (() => 1) as unknown as (row: Row) => string,
      ),
    /Skip keys must be strings/,
  );
  for (const value of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(
      () => diffSnapshot(new Map(), [{ key: "a", value }], (row) => row.key),
      /not valid JSON/,
    );
  }
});

test("subscription parameters are decoded before a Convex subscription starts", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake, () => {
    throw new TypeError("tenantId is configured, not a parameter");
  });

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
  assert.deepEqual(sink.batches, [
    { updates: [["a", [{ key: "a", value: 1 }]]], isInitial: true },
  ]);
});

test("a rejected initial snapshot re-subscribes until Skip accepts it", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);

  sink.rejectNext();
  fake.push([{ key: "a", value: 1 }]);
  await settle();

  assert.equal(fake.unsubscribed, 1);
  assert.equal(fake.subscriptionCount, 2);

  fake.push([{ key: "a", value: 1 }]);
  await pending;

  assert.equal(sink.errors.length, 1);
  assert.deepEqual(sink.batches, [
    { updates: [["a", [{ key: "a", value: 1 }]]], isInitial: true },
  ]);
});

test("a rejected update establishes a new initial snapshot", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;

  sink.rejectNext();
  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 2 },
  ]);
  await settle();
  assert.equal(fake.unsubscribed, 1);

  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 2 },
  ]);
  await settle();
  assert.equal(sink.batches.at(-1)!.isInitial, true);
  assert.deepEqual(
    new Map(sink.batches.at(-1)!.updates),
    new Map([
      ["a", [{ key: "a", value: 1 }]],
      ["b", [{ key: "b", value: 2 }]],
    ]),
  );
});

test("a queued delivery from a released subscription cannot overwrite recovery", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;

  sink.rejectNext();
  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 2 },
  ]);
  await settle();

  fake.pushFromSubscription(0, [
    { key: "a", value: 1 },
    { key: "b", value: 2 },
    { key: "stale", value: 3 },
  ]);
  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 2 },
  ]);
  await settle();

  assert.equal(sink.batches.length, 2);
  assert.equal(sink.batches.at(-1)!.isInitial, true);
  assert.deepEqual(
    new Map(sink.batches.at(-1)!.updates),
    new Map([
      ["a", [{ key: "a", value: 1 }]],
      ["b", [{ key: "b", value: 2 }]],
    ]),
  );
});

test("a normal Convex reconnect re-diffs without claiming a new initial snapshot", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const pending = service(fake).subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 2 },
  ]);
  await pending;
  fake.push([
    { key: "a", value: 1 },
    { key: "b", value: 3 },
  ]);
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
  await assert.rejects(
    convex.subscribe("i1", "missing", {}, sink.callbacks),
    SkipUnknownResourceError,
  );

  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await pending;
  convex.unsubscribe("i1");
  fake.push([{ key: "a", value: 1 }]);
  await settle();
  assert.equal(fake.unsubscribed, 1);
  assert.equal(sink.batches.length, 1);
});

test("shutdown releases subscriptions and leaves an injected client open", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await pending;
  await convex.shutdown();
  assert.equal(fake.unsubscribed, 1);
  // The caller constructed this client and may still be using it.
  assert.equal(fake.closed, 0);
});

test("shutdown closes an injected client when the caller opts in", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake, undefined, { closeClient: true });
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await pending;
  await convex.shutdown();
  assert.equal(fake.closed, 1);
});

test("a persistently failing consumer stops retrying instead of looping", async () => {
  // ConvexClient.onUpdate runs the callback "soon after being registered if a
  // result for the query is already in memory", so a re-established
  // subscription immediately redelivers. That is what turns an uncapped retry
  // into a hot loop, so the fake has to replay for this test to mean anything.
  let attaches = 0;
  let detaches = 0;
  let last: Row[] = [];
  let live: ((rows: Row[]) => unknown) | undefined;
  const push = (rows: Row[]) => {
    last = rows;
    void live?.(rows);
  };
  const replaying: ConvexSubscriber = {
    onUpdate: ((
      _query: unknown,
      _args: unknown,
      callback: (rows: Row[]) => unknown,
    ) => {
      attaches += 1;
      live = callback;
      queueMicrotask(() => {
        void callback(last);
      });
      let detached = false;
      return () => {
        if (detached) throw new Error("unsubscribe called twice");
        detached = true;
        detaches += 1;
        if (live === callback) live = undefined;
      };
    }) as ConvexSubscriber["onUpdate"],
    close: () => Promise.resolve(),
  };

  const errors: unknown[] = [];
  let updates = 0;
  const convex = new ConvexExternalService<Row>(
    replaying,
    {
      rows: defineConvexReactiveResource({
        query,
        getKey: (row: Row) => row.key,
        argsFromParams: () => ({}),
      }),
    },
    {
      scope: { tenantId: "tenant-a" },
      logger: { error: () => {} },
      resubscribeBackoffMs: 1,
      maxResubscribeAttempts: 3,
    },
  );

  push([{ key: "a", value: 1 }]);
  await convex.subscribe(
    "i1",
    "rows",
    {},
    {
      update: () => {
        updates += 1;
        // Accept the initial batch, then fail every recovery from here on.
        return updates === 1
          ? Promise.resolve()
          : Promise.reject(new Error("Skip is down"));
      },
      error: (error: unknown) => errors.push(error),
    },
  );
  assert.equal(attaches, 1);

  push([{ key: "a", value: 2 }]);
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Three recoveries were attempted, each redelivering and failing, and then
  // the subscription went inert rather than spinning.
  assert.equal(attaches, 4);
  assert.match(
    String(errors.at(-1)),
    /stopped after 3 failed recoveries and is now inert/,
  );

  // Going inert released every subscription it attached, exactly once each.
  assert.equal(detaches, attaches);

  const before = updates;
  push([{ key: "a", value: 9 }]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(updates, before);
  assert.equal(attaches, 4);

  // The inert instance was evicted, so releasing it is a harmless no-op and
  // never detaches it a second time.
  convex.unsubscribe("i1");
  await convex.shutdown();
  assert.equal(detaches, attaches);
});

test("a recovered subscription starts its next backoff from zero", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  // A budget of one means any second consecutive failure goes inert, so this
  // only passes when the accepted delivery in between reset the counter.
  const convex = service(fake, undefined, { maxResubscribeAttempts: 1 });
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;

  // Fail once, recover, then fail again. If the attempt counter were not reset
  // on the accepted delivery, the second failure would exhaust the budget.
  for (const value of [2, 3]) {
    sink.rejectNext();
    fake.push([{ key: "a", value }]);
    await settle();
    fake.push([{ key: "a", value }]);
    await settle();
  }

  assert.equal(sink.batches.at(-1)!.isInitial, true);
  assert.equal(
    sink.errors.some((error) => /now inert/.test(String(error))),
    false,
  );
});

test("the tenant scope is copied, so a later caller mutation cannot redirect it", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const seen: string[] = [];
  const scope = { tenantId: "tenant-a" };
  const convex = service(fake, undefined, { scope }, (s) => {
    seen.push(s.tenantId);
  });

  const first = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await first;

  (scope as { tenantId: string }).tenantId = "tenant-b";
  const second = convex.subscribe("i2", "rows", {}, sink.callbacks);
  fake.push([]);
  await second;

  assert.deepEqual(seen, ["tenant-a", "tenant-a"]);
});

test("a scope without a usable tenantId is rejected at construction", () => {
  const fake = new FakeConvex();
  assert.throws(
    () => service(fake, undefined, { scope: { tenantId: "" } }),
    /non-empty tenantId/,
  );
});

test("a source error before the first snapshot rejects subscribe and releases the instance", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);

  fake.fail(new Error("connection refused"));
  await assert.rejects(pending, /connection refused/);
  assert.equal(fake.unsubscribed, 1);

  // The failed attempt did not leave the instance id registered.
  const retry = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await retry;
});

test("exhausting the recovery budget during bootstrap rejects subscribe and frees the instance", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const inert: string[] = [];
  const convex = service(fake, undefined, {
    maxResubscribeAttempts: 1,
    onInert: (instance) => inert.push(instance),
  });
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);

  // One recovery is allowed, and the replacement subscription fails too.
  sink.rejectNext();
  fake.push([{ key: "a", value: 1 }]);
  await settle();
  sink.rejectNext();
  fake.push([{ key: "a", value: 1 }]);

  // Detaching on the way to inert and again when subscribe cleans up would
  // make the real client throw before the instance was deleted.
  await assert.rejects(pending, /now inert/);
  assert.equal(fake.unsubscribed, 2);
  // The caller awaiting subscribe already learned of it; the hook is for
  // subscriptions that were delivering.
  assert.deepEqual(inert, []);

  const retry = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([]);
  await retry;
});

test("a second subscribe to an open instance is refused without a new subscription", async () => {
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
  assert.equal(fake.subscriptionCount, 1);
});

test("shutdown releases every subscription and waits for in-flight deliveries", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;

  const first = convex.subscribe(
    "i1",
    "rows",
    {},
    {
      // Accept the initial batch, then hold the next delivery open.
      update: () => (++calls === 1 ? Promise.resolve() : gate),
      error: () => {},
    },
  );
  fake.pushFromSubscription(0, []);
  await first;
  const second = convex.subscribe("i2", "rows", {}, sink.callbacks);
  fake.pushFromSubscription(1, []);
  await second;

  fake.pushFromSubscription(0, [{ key: "a", value: 1 }]);
  // Let the delivery reach the gated update before shutting down.
  await settle();
  let settled = false;
  const done = convex.shutdown().then(() => {
    settled = true;
  });
  await settle();

  assert.equal(fake.unsubscribed, 2);
  assert.equal(settled, false);
  release();
  await done;
  assert.equal(settled, true);
  // The caller owns an injected client.
  assert.equal(fake.closed, 0);
});

test("recovery delays are capped however many failures precede them", async () => {
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  // Record each recovery-sized delay but fire it quickly so the test stays
  // fast. Shorter timers (the test's own settle wait) pass through untouched.
  globalThis.setTimeout = ((
    callback: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === undefined || ms < 100) return original(callback, ms, ...args);
    delays.push(ms);
    return original(callback, 1, ...args);
  }) as typeof setTimeout;
  try {
    const fake = new FakeConvex();
    const sink = recorder();
    const convex = service(fake, undefined, {
      maxResubscribeAttempts: Infinity,
      resubscribeBackoffMs: 100,
    });
    const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
    fake.push([{ key: "a", value: 1 }]);
    await pending;

    // Twelve consecutive failures: 100ms doubled twelve times would be 409600ms.
    for (let round = 0; round < 12; round += 1) {
      sink.rejectNext();
      fake.push([{ key: "a", value: round }]);
      await settle();
    }
    convex.unsubscribe("i1");

    assert.equal(delays.length, 12);
    assert.ok(delays.every((ms) => Number.isFinite(ms) && ms <= 30_000));
    assert.equal(Math.max(...delays), 30_000);
  } finally {
    globalThis.setTimeout = original;
  }
});

test("recovery options that would defeat the cap are rejected at construction", () => {
  const fake = new FakeConvex();
  for (const maxResubscribeAttempts of [Number.NaN, -1, 1.5]) {
    assert.throws(
      () => service(fake, undefined, { maxResubscribeAttempts }),
      /maxResubscribeAttempts/,
    );
  }
  for (const resubscribeBackoffMs of [Number.NaN, -1, Infinity]) {
    assert.throws(
      () => service(fake, undefined, { resubscribeBackoffMs }),
      /resubscribeBackoffMs/,
    );
  }
});

test("a delivering subscription that goes inert is reported to onInert and freed", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const inert: { instance: string; error: Error }[] = [];
  const convex = service(fake, undefined, {
    maxResubscribeAttempts: 1,
    onInert: (instance, error) => inert.push({ instance, error }),
  });
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;

  // One recovery is allowed, and the replacement subscription fails as well.
  sink.rejectNext();
  fake.push([{ key: "a", value: 2 }]);
  await settle();
  sink.rejectNext();
  fake.push([{ key: "a", value: 3 }]);
  await settle();

  assert.equal(inert.length, 1);
  assert.equal(inert[0]!.instance, "i1");
  assert.match(inert[0]!.error.message, /now inert/);
  assert.equal(fake.unsubscribed, 2);

  // The instance id was freed, so the host can subscribe again directly.
  const again = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 4 }]);
  await again;
  assert.equal(sink.batches.at(-1)!.isInitial, true);
});

test("a throwing onInert hook is logged instead of escaping recovery", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const logged: string[] = [];
  const convex = service(fake, undefined, {
    maxResubscribeAttempts: 0,
    logger: { error: (message) => logged.push(message) },
    onInert: () => {
      throw new Error("hook failed");
    },
  });
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;

  sink.rejectNext();
  fake.push([{ key: "a", value: 2 }]);
  await settle();

  assert.ok(logged.includes("Convex onInert hook failed"));
  // Shutdown still completes: nothing was left half-released.
  await convex.shutdown();
});

test("releasing before the first snapshot rejects the pending subscribe without touching a newer one", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const convex = service(fake);
  const first = convex.subscribe("i1", "rows", {}, sink.callbacks);

  convex.unsubscribe("i1");
  // The host subscribes again before the first call has finished unwinding.
  const second = convex.subscribe("i1", "rows", {}, sink.callbacks);
  await assert.rejects(first, /released before its first snapshot/);
  assert.equal(fake.unsubscribed, 1);

  // The newer subscription survived the older one's cleanup.
  fake.pushFromSubscription(1, [{ key: "a", value: 1 }]);
  await second;
  assert.equal(sink.batches.length, 1);
  convex.unsubscribe("i1");
  assert.equal(fake.unsubscribed, 2);
});

test("a re-attach that throws counts as a failed recovery instead of escaping the timer", async () => {
  const fake = new FakeConvex();
  const sink = recorder();
  const inert: Error[] = [];
  const convex = service(fake, undefined, {
    maxResubscribeAttempts: 2,
    onInert: (_instance, error) => inert.push(error),
  });
  const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
  fake.push([{ key: "a", value: 1 }]);
  await pending;

  // Both recovery attaches throw. An exception escaping the timer callback
  // would be uncaught and fail the run.
  fake.throwOnAttach.add(1).add(2);
  sink.rejectNext();
  fake.push([{ key: "a", value: 2 }]);
  await settle();
  await settle();

  assert.equal(inert.length, 1);
  assert.match(inert[0]!.message, /now inert/);
  assert.equal(fake.unsubscribed, 1);
});

test("recovery does not depend on timers having unref", async () => {
  const original = globalThis.setTimeout;
  // Non-Node runtimes return a plain number from setTimeout.
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) =>
    Number(original(...args))) as unknown as typeof setTimeout;
  try {
    const fake = new FakeConvex();
    const sink = recorder();
    const convex = service(fake);
    const pending = convex.subscribe("i1", "rows", {}, sink.callbacks);
    fake.push([{ key: "a", value: 1 }]);
    await pending;

    sink.rejectNext();
    fake.push([{ key: "a", value: 2 }]);
    await settle();

    // The delivery was retried on a fresh subscription.
    assert.equal(fake.subscriptionCount, 2);
    assert.equal(fake.unsubscribed, 1);
  } finally {
    globalThis.setTimeout = original;
  }
});
