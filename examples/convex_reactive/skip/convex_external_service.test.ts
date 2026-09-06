import assert from "node:assert/strict";
import test from "node:test";
import { diffSnapshot } from "./convex_external_service.js";

test("diffSnapshot emits inserts, changes, and deletions", () => {
  const initial = diffSnapshot(
    new Map(),
    [
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ],
    (row) => row.key,
  );
  assert.deepEqual(initial.updates, [
    ["a", [{ key: "a", value: 1 }]],
    ["b", [{ key: "b", value: 2 }]],
  ]);

  const changed = diffSnapshot(
    initial.next,
    [
      { key: "a", value: 1 },
      { key: "c", value: 3 },
    ],
    (row) => row.key,
  );
  assert.deepEqual(changed.updates, [
    ["c", [{ key: "c", value: 3 }]],
    ["b", []],
  ]);
});

test("diffSnapshot rejects duplicate keys", () => {
  assert.throws(
    () =>
      diffSnapshot(
        new Map(),
        [
          { key: "same", value: 1 },
          { key: "same", value: 2 },
        ],
        (row) => row.key,
      ),
    /Duplicate Convex snapshot key/,
  );
});
