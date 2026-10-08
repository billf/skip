import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessError } from "../readiness.js";
import {
  FaultAssertionError,
  FaultHarness,
  disconnectBeforeCheckpointFault,
  multiTableTransactionFault,
  notYetLoadedFault,
  queryFailedFault,
  queryRemovedFault,
  slowConsumerBacklogExhaustionFault,
} from "./injector.js";

function mockTrigger(): { trigger: () => void; calls: number[] } {
  const calls: number[] = [];
  let n = 0;
  return { trigger: () => calls.push((n += 1)), calls };
}

test("a consumer supplies only trigger; every factory needs nothing else", () => {
  const { trigger } = mockTrigger();
  for (const factory of [
    disconnectBeforeCheckpointFault,
    queryFailedFault,
    queryRemovedFault,
    notYetLoadedFault,
    multiTableTransactionFault,
    slowConsumerBacklogExhaustionFault,
  ]) {
    const injector = factory(trigger);
    assert.equal(typeof injector.trigger, "function");
    assert.equal(typeof injector.name, "string");
    assert.equal(typeof injector.counterName, "string");
  }
});

test("each of the three query states maps to its own expected state and counter (AE5)", () => {
  const { trigger } = mockTrigger();
  const failed = queryFailedFault(trigger);
  const removed = queryRemovedFault(trigger);
  const notYetLoaded = notYetLoadedFault(trigger);

  assert.equal(failed.expectedState, "frozen");
  assert.equal(removed.expectedState, "blank");
  assert.equal(notYetLoaded.expectedState, "not-yet-loaded");

  const counterNames = new Set([
    failed.counterName,
    removed.counterName,
    notYetLoaded.counterName,
  ]);
  assert.equal(
    counterNames.size,
    3,
    "each query state must have its own counter",
  );
});

test("detection passes when the observed state matches the injector's expected state", async () => {
  const { trigger, calls } = mockTrigger();
  const harness = new FaultHarness();
  const injector = disconnectBeforeCheckpointFault(trigger);
  await harness.run(injector, () => "frozen");
  assert.equal(calls.length, 1, "run must invoke the trigger exactly once");
  harness.assertCount(injector, 1);
});

test("detection fails when a partial result is published as current, even if it happens to match", async () => {
  const { trigger, calls } = mockTrigger();
  const harness = new FaultHarness();
  const injector = queryRemovedFault(trigger);
  await assert.rejects(
    harness.run(injector, () => "current"),
    FaultAssertionError,
  );
  await assert.rejects(
    harness.run(injector, () => "comparison-ready"),
    FaultAssertionError,
  );
  assert.equal(
    calls.length,
    2,
    "run must invoke the trigger on every attempt, pass or fail",
  );
});

test("detection fails when the observed state does not match the expected state", async () => {
  const { trigger, calls } = mockTrigger();
  const harness = new FaultHarness();
  const injector = notYetLoadedFault(trigger);
  await assert.rejects(
    harness.run(injector, () => "blank"),
    FaultAssertionError,
  );
  assert.equal(
    calls.length,
    1,
    "run must invoke the trigger even when detection fails",
  );
});

test("run observes state after the trigger resolves: the observer sees post-trigger state", async () => {
  const harness = new FaultHarness();
  let faultVisible = false;
  const injector = disconnectBeforeCheckpointFault(() => {
    faultVisible = true;
  });
  let observedDuringRun: boolean | null = null;
  const checkpoint = await harness.run(injector, () => {
    observedDuringRun = faultVisible;
    return "frozen";
  });
  assert.equal(
    observedDuringRun,
    true,
    "the observer must run after trigger() settles",
  );
  harness.assertRecovered(injector, checkpoint, true);
});

test("detection compares post-trigger state: a pre-trigger 'current' that the trigger freezes passes", async () => {
  const harness = new FaultHarness();
  let state: "current" | "frozen" = "current";
  const injector = disconnectBeforeCheckpointFault(() => {
    state = "frozen";
  });
  // The observer reads live state after trigger(); under the old
  // pre-computed-value contract this observation could only ever have
  // been the stale pre-trigger "current" and would have failed.
  const checkpoint = await harness.run(injector, () => state);
  harness.assertCount(injector, 1);
  harness.assertRecovered(injector, checkpoint, true);
});

test("run awaits an async observer", async () => {
  const { trigger, calls } = mockTrigger();
  const harness = new FaultHarness();
  const injector = disconnectBeforeCheckpointFault(trigger);
  const checkpoint = await harness.run(
    injector,
    async (): Promise<"frozen"> => "frozen",
  );
  assert.equal(calls.length, 1, "run must invoke the trigger exactly once");
  harness.assertCount(injector, 1);
  harness.assertRecovered(injector, checkpoint, true);
});

test("a no-op trigger reporting no fault injected fails closed and does not increment the counter", async () => {
  const harness = new FaultHarness();
  let calls = 0;
  const injector = disconnectBeforeCheckpointFault(() => {
    calls += 1;
    return false;
  });
  await assert.rejects(
    harness.run(injector, () => "frozen"),
    FaultAssertionError,
  );
  assert.equal(
    calls,
    1,
    "the trigger still ran; it is the fault occurrence that must not count",
  );
  harness.assertCount(injector, 0);
});

test("recovery that never matches fails the assertion", async () => {
  const { trigger, calls } = mockTrigger();
  const harness = new FaultHarness();
  const injector = disconnectBeforeCheckpointFault(trigger);
  const checkpoint = await harness.run(injector, () => "frozen");
  assert.equal(calls.length, 1, "run must invoke the trigger exactly once");
  assert.throws(
    () => harness.assertRecovered(injector, checkpoint, false),
    FaultAssertionError,
  );
  harness.assertRecovered(injector, checkpoint, true); // no throw
});

test("assertRecovered rejects a fabricated checkpoint, a cross-injector checkpoint, and reuse after a pass", async () => {
  const { trigger } = mockTrigger();
  const harness = new FaultHarness();
  const injector = disconnectBeforeCheckpointFault(trigger);
  const other = queryFailedFault(trigger);

  // No preceding successful run: any checkpoint is fabricated.
  assert.throws(
    () =>
      harness.assertRecovered(
        injector,
        { injectorName: injector.name, runSequence: 1 },
        true,
      ),
    FaultAssertionError,
  );

  const checkpoint = await harness.run(injector, () => "frozen");
  // Cross-injector receipt.
  assert.throws(
    () => harness.assertRecovered(other, checkpoint, true),
    FaultAssertionError,
  );
  // A forged sequence for the right injector.
  assert.throws(
    () =>
      harness.assertRecovered(
        injector,
        {
          injectorName: injector.name,
          runSequence: checkpoint.runSequence + 100,
        },
        true,
      ),
    FaultAssertionError,
  );
  harness.assertRecovered(injector, checkpoint, true); // no throw
  // Single-use: already consumed by the passing assertion above.
  assert.throws(
    () => harness.assertRecovered(injector, checkpoint, true),
    FaultAssertionError,
  );
});

test("assertRecovered rejects a stale checkpoint superseded by a later run", async () => {
  const { trigger } = mockTrigger();
  const harness = new FaultHarness();
  const injector = disconnectBeforeCheckpointFault(trigger);
  const stale = await harness.run(injector, () => "frozen");
  const latest = await harness.run(injector, () => "frozen");
  assert.throws(
    () => harness.assertRecovered(injector, stale, true),
    FaultAssertionError,
  );
  harness.assertRecovered(injector, latest, true); // no throw
  harness.assertCount(injector, 2);
});

test("a double count fails", async () => {
  const { trigger, calls } = mockTrigger();
  const harness = new FaultHarness();
  const injector = multiTableTransactionFault(trigger);
  await harness.run(injector, () => "frozen");
  await harness.run(injector, () => "frozen"); // triggered twice
  assert.equal(calls.length, 2, "each run must invoke the trigger");
  assert.throws(() => harness.assertCount(injector, 1), FaultAssertionError);
  harness.assertCount(injector, 2); // no throw
});

test("an unknown-event incomparable suspends the recovery assertion as a harness error, not a fault pass/fail, but still counts the fault", async () => {
  const { trigger, calls } = mockTrigger();
  const harness = new FaultHarness();
  const injector = slowConsumerBacklogExhaustionFault(trigger);
  await assert.rejects(
    harness.run(injector, () => "frozen", 2),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError);
      assert.ok(
        !(error instanceof FaultAssertionError),
        "must not be classified as a fault pass/fail",
      );
      return true;
    },
  );
  assert.equal(
    calls.length,
    1,
    "the trigger ran; only the comparison is suspended",
  );
  // The fault still happened and its counter still incremented.
  harness.assertCount(injector, 1);
  // The suspended run issued no checkpoint, so recovery cannot be asserted.
  assert.throws(
    () =>
      harness.assertRecovered(
        injector,
        { injectorName: injector.name, runSequence: 1 },
        true,
      ),
    FaultAssertionError,
  );
});
