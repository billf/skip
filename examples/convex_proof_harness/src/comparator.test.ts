import assert from "node:assert/strict";
import { test } from "node:test";
import { compareFeeds } from "./comparator.js";
import { loadCorpus, resolveExpectedFeed, type FeedRow } from "./corpus.js";

function row(over: Partial<FeedRow> = {}): FeedRow {
  return {
    _id: "m1",
    _creationTime: 10,
    room: "r1",
    body: "hi",
    sender: { _id: "u1", name: "Ada" },
    likeCount: 0,
    ...over,
  };
}

test("identical feeds match", () => {
  const feed = [row(), row({ _id: "m2", _creationTime: 9 })];
  assert.deepEqual(compareFeeds("V-test", feed, feed), []);
});

test("each compared field, mutated alone, yields exactly one mismatch naming that field", () => {
  const mutations: [string, Partial<FeedRow>][] = [
    ["_id", { _id: "other" }],
    ["_creationTime", { _creationTime: 11 }],
    ["room", { room: "r2" }],
    ["body", { body: "bye" }],
    ["likeCount", { likeCount: 1 }],
    ["sender", { sender: { _id: "u2", name: "Ada" } }],
    ["sender", { sender: { _id: "u1", name: "Bea" } }],
    ["sender", { sender: null }],
  ];
  for (const [field, over] of mutations) {
    const mismatches = compareFeeds("V-test", [row()], [row(over)]);
    assert.equal(
      mismatches.length,
      1,
      `mutating ${field} (${JSON.stringify(over)}) should yield one mismatch`,
    );
    assert.equal(mismatches[0]!.field, field);
  }
});

test("a duplicated _id on either side surfaces as a duplicate-id mismatch", () => {
  const dupExpected = [row(), row()];
  assert.ok(
    compareFeeds("V-test", dupExpected, [row()]).some(
      (m) => m.field === "duplicate-id" && m.key === "m1",
    ),
  );
  const dupActual = [row(), row()];
  assert.ok(
    compareFeeds("V-test", [row()], dupActual).some(
      (m) => m.field === "duplicate-id" && m.key === "m1",
    ),
  );
});

test("wrong likeCount produces a mismatch naming the key and field", () => {
  const expected = [row({ likeCount: 2 })];
  const actual = [row({ likeCount: 1 })];
  const mismatches = compareFeeds("V-test", expected, actual);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.key, "m1");
  assert.equal(mismatches[0]!.field, "likeCount");
});

test("a swapped tie produces a mismatch at the swapped position", () => {
  const a = row({ _id: "a", _creationTime: 10 });
  const b = row({ _id: "b", _creationTime: 10 });
  const expected = [b, a]; // b (higher id) sorts first, per the descending _id tie-break
  const actual = [a, b]; // swapped
  const mismatches = compareFeeds("V-test", expected, actual);
  assert.ok(mismatches.some((m) => m.field === "_id"));
});

test("an included 51st (extra) row produces a mismatch", () => {
  const expected = [row({ _id: "m1" })];
  const actual = [row({ _id: "m1" }), row({ _id: "m2" })];
  const mismatches = compareFeeds("V-test", expected, actual);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.field, "presence");
  assert.equal(mismatches[0]!.key, "m2");
});

test('"Unknown" in place of null produces a sender mismatch', () => {
  const expected = [row({ sender: null })];
  const actual = [{ ...row(), sender: "Unknown" }];
  const mismatches = compareFeeds("V-test", expected, actual);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.field, "sender");
});

test("a missing row produces a mismatch", () => {
  const expected = [row({ _id: "m1" }), row({ _id: "m2" })];
  const actual = [row({ _id: "m1" })];
  const mismatches = compareFeeds("V-test", expected, actual);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.field, "presence");
  assert.equal(mismatches[0]!.key, "m2");
});

test("an extra row (unrelated to any expected row) produces a mismatch", () => {
  const expected: FeedRow[] = [];
  const actual = [row()];
  const mismatches = compareFeeds("V-test", expected, actual);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.field, "presence");
  assert.equal(mismatches[0]!.key, "m1");
});

test("every V1-V6 expected output matches itself", () => {
  const corpus = loadCorpus();
  for (const [key, vector] of Object.entries(corpus.vectors)) {
    // An identity label map is sufficient: comparing an expected feed to
    // itself only needs consistent (not real) ids.
    const idByLabel = new Map<string, string>();
    const collectLabels = (
      rows: { id: string; room: string; sender: { id: string } | null }[],
    ) => {
      for (const r of rows) {
        idByLabel.set(r.id, r.id);
        idByLabel.set(r.room, r.room);
        if (r.sender !== null) idByLabel.set(r.sender.id, r.sender.id);
      }
    };
    collectLabels(vector.expectedBase);
    for (const step of vector.expectedAfterDelta ?? []) {
      if (step !== null) collectLabels(step);
    }
    for (const independent of vector.independentDeltas ?? []) {
      collectLabels(independent.expected);
    }

    const resolvedBase = resolveExpectedFeed(vector.expectedBase, idByLabel);
    assert.deepEqual(
      compareFeeds(key, resolvedBase, resolvedBase),
      [],
      `${key} base`,
    );

    for (const [i, step] of (vector.expectedAfterDelta ?? []).entries()) {
      if (step === null) continue;
      const resolved = resolveExpectedFeed(step, idByLabel);
      assert.deepEqual(
        compareFeeds(key, resolved, resolved),
        [],
        `${key} delta ${i}`,
      );
    }
    for (const independent of vector.independentDeltas ?? []) {
      const resolved = resolveExpectedFeed(independent.expected, idByLabel);
      assert.deepEqual(
        compareFeeds(key, resolved, resolved),
        [],
        `${key} ${independent.title}`,
      );
    }
  }
});

test("a _creationTime-only divergence produces a mismatch naming _creationTime", () => {
  const expected = [row({ _creationTime: 10 })];
  const actual = [row({ _creationTime: 11 })];
  const mismatches = compareFeeds("V-test", expected, actual);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.key, "m1");
  assert.equal(mismatches[0]!.field, "_creationTime");
});

test("a null row in actual produces a presence mismatch instead of throwing", () => {
  const expected = [row({ _id: "m1" })];
  const actual = [null];
  const mismatches = compareFeeds("V-test", expected, actual);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.field, "presence");
  assert.equal(mismatches[0]!.key, "m1");
  assert.equal(mismatches[0]!.actual, null);
});

test("a sender carrying an extra field still matches on _id/name", () => {
  const expected = [row()];
  const actual = [
    { ...row(), sender: { _id: "u1", name: "Ada", email: "ada@example.com" } },
  ];
  assert.deepEqual(compareFeeds("V-test", expected, actual), []);
});
