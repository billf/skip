import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG,
  DIRECTION_TAGGED_METRICS,
  lookupMetric,
  requirementFor,
  requiredMetricsFor,
} from "./catalog.js";

test("every catalog entry names all four directions", () => {
  for (const entry of CATALOG) {
    for (const direction of ["1a", "1b", "1c", "D2"] as const) {
      assert.ok(
        entry.profile[direction] !== undefined,
        `${entry.name} missing profile for ${direction}`,
      );
    }
  }
});

test("mismatch is the only metric required for 1a", () => {
  assert.deepEqual(requiredMetricsFor("1a"), ["mismatch"]);
});

test("1b's required-metric set is pinned against the core profile table", () => {
  assert.deepEqual(requiredMetricsFor("1b"), [
    "sourceRowsBytes",
    "atomicBatches",
    "changedKeys",
    "dependentWork",
    "reducerWork",
    "mismatch",
  ]);
});

test("1c's required-metric set is pinned against the core profile table", () => {
  assert.deepEqual(requiredMetricsFor("1c"), [
    "sourceRowsBytes",
    "atomicBatches",
    "changedKeys",
    "dependentWork",
    "reducerWork",
    "staleDuration",
    "mismatch",
  ]);
});

test("D2's required-metric set is pinned against the core profile table", () => {
  assert.deepEqual(requiredMetricsFor("D2"), [
    "sourceRowsBytes",
    "atomicBatches",
    "changedKeys",
    "dependentWork",
    "reducerWork",
    "staleDuration",
    "mismatch",
    "fallback",
  ]);
});

test("fallback is required only for D2", () => {
  assert.equal(requirementFor("fallback", "D2"), "required");
  for (const direction of ["1a", "1b", "1c"] as const) {
    assert.equal(requirementFor("fallback", direction), "not-applicable");
  }
});

test("requirementFor throws on an unknown metric name", () => {
  assert.throws(() => requirementFor("nope", "1a"));
});

test("lookupMetric returns undefined for an unknown name", () => {
  assert.equal(lookupMetric("nope"), undefined);
});

test("sourceRowsBytes is the only direction-tagged metric", () => {
  assert.deepEqual([...DIRECTION_TAGGED_METRICS], ["sourceRowsBytes"]);
});
