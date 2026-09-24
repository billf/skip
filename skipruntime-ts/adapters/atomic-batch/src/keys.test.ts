import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNoDuplicateKeys,
  compareOrderKeyDesc,
  namespacedKey,
} from "./keys.js";

test("namespacedKey joins component/table/id", () => {
  assert.equal(
    namespacedKey("room-feed", "messages", "m1"),
    "room-feed/messages/m1",
  );
});

test('namespacedKey rejects a segment containing "/"', () => {
  assert.throws(
    () => namespacedKey("room-feed", "messages", "m1/evil"),
    /contains "\//,
  );
  assert.throws(
    () => namespacedKey("room-feed", "mess/ages", "m1"),
    /contains "\//,
  );
  assert.throws(
    () => namespacedKey("room/feed", "messages", "m1"),
    /contains "\//,
  );
});

test("assertNoDuplicateKeys accepts unique keys", () => {
  assert.doesNotThrow(() => {
    assertNoDuplicateKeys([
      ["a", 1],
      ["b", 2],
    ]);
  });
});

test("assertNoDuplicateKeys rejects a repeated key", () => {
  assert.throws(() => {
    assertNoDuplicateKeys([
      ["a", 1],
      ["a", 2],
    ]);
  }, /duplicate key/);
});

test("compareOrderKeyDesc orders by descending creationTime first", () => {
  const older = { creationTime: 1, id: "z" };
  const newer = { creationTime: 2, id: "a" };
  assert.ok(compareOrderKeyDesc(newer, older) < 0);
  assert.ok(compareOrderKeyDesc(older, newer) > 0);
});

test("compareOrderKeyDesc breaks a creationTime tie by descending _id", () => {
  const a = { creationTime: 5, id: "a" };
  const b = { creationTime: 5, id: "b" };
  assert.ok(
    compareOrderKeyDesc(b, a) < 0,
    "b (higher id) should sort before a",
  );
  assert.ok(compareOrderKeyDesc(a, b) > 0);
  assert.equal(compareOrderKeyDesc(a, { ...a }), 0);
});

test("compareOrderKeyDesc never returns NaN for non-finite creationTime inputs", () => {
  const nan = { creationTime: NaN, id: "a" };
  const finite = { creationTime: 5, id: "b" };
  for (const [a, b] of [
    [nan, finite],
    [finite, nan],
    [nan, { ...nan }],
  ] as const) {
    const result = compareOrderKeyDesc(a, b);
    assert.ok(
      Number.isFinite(result),
      `expected a finite result, got ${result}`,
    );
  }
  // NaN sorts after every ordered value in descending order.
  assert.ok(compareOrderKeyDesc(nan, finite) > 0);
  assert.ok(compareOrderKeyDesc(finite, nan) < 0);
});

test("compareOrderKeyDesc orders infinite creationTime values deterministically", () => {
  const posInf = { creationTime: Infinity, id: "a" };
  const negInf = { creationTime: -Infinity, id: "a" };
  const finite = { creationTime: 1, id: "z" };
  assert.ok(compareOrderKeyDesc(posInf, finite) < 0);
  assert.ok(compareOrderKeyDesc(finite, posInf) > 0);
  assert.ok(compareOrderKeyDesc(negInf, finite) > 0);
  assert.ok(compareOrderKeyDesc(finite, negInf) < 0);
});
