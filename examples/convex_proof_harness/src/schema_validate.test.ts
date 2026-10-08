import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareFeeds } from "./comparator.js";
import { Recorder } from "./recorder.js";
import { type JsonSchema, validate } from "./schema_validate.js";

const SCHEMA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
);

function loadSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")) as JsonSchema;
}

/**
 * Pinned canonical-shape hashes (U16 finding #5): a schema-shape edit
 * (added/removed/renamed property, changed required/enum) changes the
 * hash and fails this test, forcing the author to bump `schemaVersion`
 * and record the new hash together -- the "version together" guarantee
 * in METHODOLOGY.md made mechanical. Canonical form is key-sorted JSON;
 * formatting-only edits do not change the hash.
 */
const EXPECTED_SCHEMA_SHAPE_HASHES: Record<string, string> = {
  "report.schema.json":
    "2a7a25f843ad23766ec159425d8b57a47f7834e3e6e1978e62a00be981868d01",
  "mismatch.schema.json":
    "158b00eca8d399b9943fe2e0c5f9264059b405b6965ec0f655fd9545fd72611f",
};

test("schema shapes match their pinned hashes (bump schemaVersion + hashes together on shape change)", () => {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = canonicalize((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  for (const [name, expected] of Object.entries(EXPECTED_SCHEMA_SHAPE_HASHES)) {
    const raw = readFileSync(join(SCHEMA_DIR, name), "utf8");
    const actual = createHash("sha256")
      .update(JSON.stringify(canonicalize(JSON.parse(raw))))
      .digest("hex");
    assert.equal(
      actual,
      expected,
      `${name} shape changed: bump schemaVersion and record the new hash`,
    );
  }
});

test("both schemas carry an $id and a schemaVersion for U16 to reference by version", () => {
  for (const name of ["report.schema.json", "mismatch.schema.json"]) {
    const raw = JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")) as {
      $id?: string;
      schemaVersion?: string;
    };
    assert.equal(typeof raw.$id, "string");
    assert.equal(raw.schemaVersion, "1.0.0");
  }
});

test("U7's report fixture (a full checkpoint record) validates against report.schema.json", () => {
  const schema = loadSchema("report.schema.json");
  const lines: string[] = [];
  const recorder = new Recorder((line) => lines.push(line));
  recorder.record("1c", 7, { kind: "current" }, [
    { name: "mismatch", value: 0 },
    { name: "atomicBatches", value: 1 },
    { name: "changedKeys", value: 2 },
    { name: "dependentWork", value: 2 },
    { name: "reducerWork", value: 0 },
    { name: "staleDuration", value: 0 },
    { name: "sourceRowsBytes", value: 5, representation: "revisions" },
  ]);
  const record = JSON.parse(lines[0]!) as unknown;
  assert.deepEqual(validate(schema, record), []);
});

test("every freshness disposition variant validates", () => {
  const schema = loadSchema("report.schema.json");
  const variants = [
    { kind: "current" },
    { kind: "stale-with-reason", reason: "reconnecting" },
    { kind: "fallback-with-reason", reason: "index not ready" },
  ];
  for (const freshness of variants) {
    const record = {
      event: "checkpoint",
      direction: "1a",
      version: 1,
      freshness,
      metrics: [],
    };
    assert.deepEqual(validate(schema, record), [], JSON.stringify(freshness));
  }
});

test("a report with a renamed metric field fails validation", () => {
  const schema = loadSchema("report.schema.json");
  const record = {
    event: "checkpoint",
    direction: "1a",
    version: 1,
    freshness: { kind: "current" },
    metrics: [{ metricName: "mismatch", value: 0 }], // renamed "name" -> "metricName"
  };
  const errors = validate(schema, record);
  assert.ok(errors.length > 0);
});

test("a report missing a required top-level field fails validation", () => {
  const schema = loadSchema("report.schema.json");
  const record = {
    event: "checkpoint",
    direction: "1a",
    version: 1,
    metrics: [],
  }; // no freshness
  const errors = validate(schema, record);
  assert.ok(errors.some((e) => e.path === "$.freshness"));
});

test("U6's mismatch fixtures validate against mismatch.schema.json", () => {
  const schema = loadSchema("mismatch.schema.json");
  const mismatches = compareFeeds(
    "V-test",
    [
      {
        _id: "m1",
        _creationTime: 1,
        room: "r1",
        body: "hi",
        sender: null,
        likeCount: 0,
      },
    ],
    [
      {
        _id: "m1",
        _creationTime: 1,
        room: "r1",
        body: "hi",
        sender: null,
        likeCount: 1,
      },
    ],
  );
  assert.equal(mismatches.length, 1);
  assert.deepEqual(validate(schema, mismatches[0]), []);
});

test("a mismatch with a renamed field fails validation", () => {
  const schema = loadSchema("mismatch.schema.json");
  const renamed = {
    vectorName: "V-test",
    key: "m1",
    field: "likeCount",
    expected: 0,
    actual: 1,
  };
  assert.ok(validate(schema, renamed).length > 0);
});

test("a mismatch's null key is allowed and an undefined expected side passes in-memory (dropped on JSON round-trip, see round-trip tests below)", () => {
  const schema = loadSchema("mismatch.schema.json");
  const record = {
    vector: "V-test",
    key: null,
    field: "presence",
    expected: undefined,
    actual: {},
  };
  assert.deepEqual(validate(schema, record), []);
});

test("a missing-row presence mismatch validates after a JSON round-trip", () => {
  const schema = loadSchema("mismatch.schema.json");
  const row = {
    _id: "m1",
    _creationTime: 1,
    room: "r1",
    body: "hi",
    sender: null,
    likeCount: 0,
  };
  const mismatches = compareFeeds("V-test", [row], []);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.field, "presence");
  const roundTripped = JSON.parse(JSON.stringify(mismatches[0])) as Record<
    string,
    unknown
  >;
  assert.ok(
    !("actual" in roundTripped),
    "expected the undefined side to be dropped by JSON round-trip",
  );
  assert.deepEqual(validate(schema, roundTripped), []);
});

test("an extra-row presence mismatch validates after a JSON round-trip", () => {
  const schema = loadSchema("mismatch.schema.json");
  const row = {
    _id: "m1",
    _creationTime: 1,
    room: "r1",
    body: "hi",
    sender: null,
    likeCount: 0,
  };
  const mismatches = compareFeeds("V-test", [], [row]);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.field, "presence");
  const roundTripped = JSON.parse(JSON.stringify(mismatches[0])) as Record<
    string,
    unknown
  >;
  assert.ok(
    !("expected" in roundTripped),
    "expected the undefined side to be dropped by JSON round-trip",
  );
  assert.deepEqual(validate(schema, roundTripped), []);
});

test("a null-row presence mismatch (actual: null) validates after a JSON round-trip", () => {
  const schema = loadSchema("mismatch.schema.json");
  const row = {
    _id: "m1",
    _creationTime: 1,
    room: "r1",
    body: "hi",
    sender: null,
    likeCount: 0,
  };
  const mismatches = compareFeeds("V-test", [row], [null]);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.actual, null);
  const roundTripped = JSON.parse(JSON.stringify(mismatches[0])) as unknown;
  assert.deepEqual(validate(schema, roundTripped), []);
});

test("non-finite metric values fail validation", () => {
  const schema = loadSchema("report.schema.json");
  assert.deepEqual(validate({ type: "number" }, 1.5), []);
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.ok(
      validate({ type: "number" }, bad).length > 0,
      `expected ${String(bad)} to be rejected`,
    );
    const record = {
      event: "checkpoint",
      direction: "1a",
      version: 1,
      freshness: { kind: "current" },
      metrics: [{ name: "mismatch", value: bad }],
    };
    assert.ok(
      validate(schema, record).length > 0,
      `expected metric value ${String(bad)} to be rejected`,
    );
  }
});

test("a report with a bad direction enum fails validation", () => {
  const schema = loadSchema("report.schema.json");
  const record = {
    event: "checkpoint",
    direction: "1z",
    version: 1,
    freshness: { kind: "current" },
    metrics: [],
  };
  const errors = validate(schema, record);
  assert.ok(
    errors.some((e) => e.path === "$.direction"),
    JSON.stringify(errors),
  );
});

test("a freshness value matching no oneOf variant fails validation", () => {
  const schema = loadSchema("report.schema.json");
  const record = {
    event: "checkpoint",
    direction: "1a",
    version: 1,
    freshness: { kind: "current", reason: "x" }, // 0-of-3: extra reason kills "current", kind kills the reasoned variants
    metrics: [],
  };
  const errors = validate(schema, record);
  assert.ok(
    errors.some((e) => e.path === "$.freshness"),
    JSON.stringify(errors),
  );
});

test("an extra top-level property fails validation", () => {
  const schema = loadSchema("report.schema.json");
  const record = {
    event: "checkpoint",
    direction: "1a",
    version: 1,
    freshness: { kind: "current" },
    metrics: [],
    extra: "not allowed",
  };
  const errors = validate(schema, record);
  assert.ok(
    errors.some((e) => e.path === "$.extra"),
    JSON.stringify(errors),
  );
});
