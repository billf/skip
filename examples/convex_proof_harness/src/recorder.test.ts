import assert from "node:assert/strict";
import { test } from "node:test";
import { CATALOG, type Direction } from "./catalog.js";
import { HarnessError } from "./readiness.js";
import {
  Recorder,
  type CheckpointRecord,
  type MetricSample,
} from "./recorder.js";

/**
 * Independently hardcoded required-metric sets, mirroring the pinned lists
 * in catalog.test.ts. These fixtures intentionally do NOT derive from
 * CATALOG.filter: if a catalog requirement changes by mistake, both the
 * fixture and the recorder's expectation must not move together (M5).
 */
const EXPECTED_REQUIRED: Readonly<Record<Direction, readonly string[]>> = {
  "1a": ["mismatch"],
  "1b": [
    "sourceRowsBytes",
    "atomicBatches",
    "changedKeys",
    "dependentWork",
    "reducerWork",
    "mismatch",
  ],
  "1c": [
    "sourceRowsBytes",
    "atomicBatches",
    "changedKeys",
    "dependentWork",
    "reducerWork",
    "staleDuration",
    "mismatch",
  ],
  D2: [
    "sourceRowsBytes",
    "atomicBatches",
    "changedKeys",
    "dependentWork",
    "reducerWork",
    "staleDuration",
    "mismatch",
    "fallback",
  ],
};

const EXPECTED_REPRESENTATION = {
  "1b": "snapshot-rows",
  "1c": "revisions",
  D2: "revisions",
} as const;

function allRequiredSamples(direction: Direction): MetricSample[] {
  return EXPECTED_REQUIRED[direction].map((name) => ({
    name,
    value: 1,
    ...(name === "sourceRowsBytes" && direction !== "1a"
      ? { representation: EXPECTED_REPRESENTATION[direction] }
      : {}),
  }));
}

test("an unknown metric name throws", () => {
  const recorder = new Recorder();
  assert.throws(
    () =>
      recorder.record("1c", 1, { kind: "current" }, [
        { name: "not-a-real-metric", value: 1 },
      ]),
    HarnessError,
  );
});

test("a missing required metric for the chosen direction profile is a harness error", () => {
  const recorder = new Recorder();
  assert.throws(
    () => recorder.record("1c", 1, { kind: "current" }, []),
    HarnessError,
  );
});

test("1a's correctness-only profile accepts only the mismatch count", () => {
  const recorder = new Recorder();
  recorder.record("1a", 1, { kind: "current" }, [
    { name: "mismatch", value: 0 },
  ]);
  assert.equal(recorder.jsonl.trim().length > 0, true);

  // Everything else is not-applicable for 1a.
  for (const entry of CATALOG) {
    if (entry.name === "mismatch") continue;
    // Carry the required `mismatch` sample so only the not-applicable
    // guard can reject; otherwise the missing-required guard throws first
    // and this loop passes with the guard removed.
    assert.throws(
      () =>
        recorder.record("1a", 1, { kind: "current" }, [
          { name: "mismatch", value: 0 },
          { name: entry.name, value: 1 },
        ]),
      (err: unknown) =>
        err instanceof HarnessError &&
        /not-applicable/.test(err.message) &&
        err.message.includes(entry.name),
      `expected "${entry.name}" to be rejected as not-applicable for direction 1a`,
    );
  }
});

test("a direction tag is required on the snapshot-row and revision slots", () => {
  const recorder = new Recorder();
  const samplesWithoutTag = allRequiredSamples("1b").map((s) =>
    s.name === "sourceRowsBytes" ? { name: s.name, value: s.value } : s,
  );
  assert.throws(
    () => recorder.record("1b", 1, { kind: "current" }, samplesWithoutTag),
    HarnessError,
  );

  // Tagged, it succeeds.
  const tagged: MetricSample[] = allRequiredSamples("1b").map((s) =>
    s.name === "sourceRowsBytes"
      ? { ...s, representation: "snapshot-rows" as const }
      : s,
  );
  recorder.record("1b", 1, { kind: "current" }, tagged);
});

test("every direction's full required-metric set records successfully and writes valid JSONL", () => {
  for (const direction of ["1a", "1b", "1c", "D2"] as const) {
    const recorder = new Recorder();
    recorder.record(
      direction,
      7,
      { kind: "current" },
      allRequiredSamples(direction),
    );
    const lines = recorder.jsonl.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as CheckpointRecord;
    assert.equal(parsed.event, "checkpoint");
    assert.equal(parsed.direction, direction);
    assert.equal(parsed.version, 7);
  }
});

test("freshness disposition is recorded, not inferred, for stale and fallback cases", () => {
  const recorder = new Recorder();
  recorder.record(
    "1c",
    1,
    { kind: "stale-with-reason", reason: "reconnect in progress" },
    [
      { name: "mismatch", value: 0 },
      { name: "atomicBatches", value: 1 },
      { name: "changedKeys", value: 1 },
      { name: "dependentWork", value: 1 },
      { name: "reducerWork", value: 0 },
      { name: "staleDuration", value: 120 },
      { name: "sourceRowsBytes", value: 3, representation: "revisions" },
    ],
  );
  const parsed = JSON.parse(recorder.jsonl.trim()) as CheckpointRecord;
  assert.deepEqual(parsed.freshness, {
    kind: "stale-with-reason",
    reason: "reconnect in progress",
  });
});

test("a sink is used instead of the in-memory accumulator when supplied", () => {
  const lines: string[] = [];
  const recorder = new Recorder((line) => lines.push(line));
  recorder.record("1a", 1, { kind: "current" }, [
    { name: "mismatch", value: 0 },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(recorder.jsonl, "");
});

test("a swapped representation tag is rejected for each direction", () => {
  // 1b reads snapshot rows, so a revisions tag must fail.
  const recorder1b = new Recorder();
  const swapped1b = allRequiredSamples("1b").map((s) =>
    s.name === "sourceRowsBytes"
      ? { ...s, representation: "revisions" as const }
      : s,
  );
  assert.throws(
    () => recorder1b.record("1b", 1, { kind: "current" }, swapped1b),
    HarnessError,
  );

  // 1c reads emitted revisions, so a snapshot-rows tag must fail.
  const recorder1c = new Recorder();
  const swapped1c = allRequiredSamples("1c").map((s) =>
    s.name === "sourceRowsBytes"
      ? { ...s, representation: "snapshot-rows" as const }
      : s,
  );
  assert.throws(
    () => recorder1c.record("1c", 1, { kind: "current" }, swapped1c),
    HarnessError,
  );

  // D2 reads emitted revisions, so a snapshot-rows tag must fail.
  const recorderD2 = new Recorder();
  const swappedD2 = allRequiredSamples("D2").map((s) =>
    s.name === "sourceRowsBytes"
      ? { ...s, representation: "snapshot-rows" as const }
      : s,
  );
  assert.throws(
    () => recorderD2.record("D2", 1, { kind: "current" }, swappedD2),
    HarnessError,
  );
});

test("non-finite metric values are rejected before sinking", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const recorder = new Recorder();
    assert.throws(
      () =>
        recorder.record("1a", 1, { kind: "current" }, [
          { name: "mismatch", value: bad },
        ]),
      HarnessError,
      `expected value ${String(bad)} to be rejected`,
    );
    assert.equal(recorder.jsonl, "", "rejected record must not sink a line");
  }
});

test("a non-finite checkpoint version is rejected before sinking", () => {
  for (const badVersion of [NaN, Infinity, -Infinity]) {
    const recorder = new Recorder();
    assert.throws(
      () =>
        recorder.record("1a", badVersion, { kind: "current" }, [
          { name: "mismatch", value: 0 },
        ]),
      HarnessError,
      `expected version ${String(badVersion)} to be rejected`,
    );
    assert.equal(recorder.jsonl, "", "rejected record must not sink a line");
  }
});

test("a duplicate metric name in one record call is rejected", () => {
  const recorder = new Recorder();
  assert.throws(
    () =>
      recorder.record("1a", 1, { kind: "current" }, [
        { name: "mismatch", value: 0 },
        { name: "mismatch", value: 1 },
      ]),
    HarnessError,
  );
  assert.equal(recorder.jsonl, "", "rejected record must not sink a line");
});

test("a stray representation tag on a non-direction-tagged metric is rejected", () => {
  const recorder = new Recorder();
  assert.throws(
    () =>
      recorder.record("1a", 1, { kind: "current" }, [
        { name: "mismatch", value: 0, representation: "revisions" },
      ]),
    HarnessError,
  );
  assert.equal(recorder.jsonl, "", "rejected record must not sink a line");
});
