import assert from "node:assert/strict";
import { test } from "node:test";
import { deepEqual } from "./deep_equal.js";

test("deepEqual pins the shared semantics: identity, null/undefined, nesting", () => {
  assert.equal(deepEqual(1, 1), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1 }), true);
  assert.equal(deepEqual(null, null), true);
  assert.equal(deepEqual(undefined, undefined), true);
  assert.equal(deepEqual(null, undefined), false);
  assert.equal(deepEqual(undefined, {}), false);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual([1, 2], [1, 2]), true);
  // NaN is unequal to itself (Object.is deliberately NOT used).
  assert.equal(deepEqual(NaN, NaN), false);
});
