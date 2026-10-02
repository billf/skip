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
  // Compare as a Map: Entry<K, V> carries no ordering contract, so asserting on
  // array order would pin diffSnapshot's iteration rather than its behaviour.
  assert.deepEqual(
    new Map(initial.updates),
    new Map([
      ["a", [{ key: "a", value: 1 }]],
      ["b", [{ key: "b", value: 2 }]],
    ]),
  );

  const changed = diffSnapshot(
    initial.next,
    [
      { key: "a", value: 1 },
      { key: "c", value: 3 },
    ],
    (row) => row.key,
  );
  assert.deepEqual(
    new Map(changed.updates),
    new Map([
      ["c", [{ key: "c", value: 3 }]],
      ["b", []],
    ]),
  );
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

// `ConvexReactiveResource.query` is an untyped FunctionReference, so `Row` is
// asserted rather than verified: a schema using v.int64()/v.bytes() typechecks
// at the call site and only fails at the boundary. These casts reproduce that.
const untyped = (row: unknown) => row as { key: string };

test("diffSnapshot rejects Convex values Skip cannot represent", () => {
  // v.int64() -> bigint. Skip's exportJSON throws an opaque wasm error on this,
  // so the adapter names it at the boundary instead.
  assert.throws(
    () =>
      diffSnapshot(
        new Map(),
        [untyped({ key: "a", n: 1n })],
        (row) => row.key,
      ),
    /bigint \(v\.int64\)/,
  );

  // v.bytes() -> ArrayBuffer. This one is worse: exportJSON emits {} silently,
  // so without this guard it would reach the graph as data loss, not an error.
  assert.throws(
    () =>
      diffSnapshot(
        new Map(),
        [untyped({ key: "a", blob: new ArrayBuffer(8) })],
        (row) => row.key,
      ),
    /binary \(v\.bytes\)/,
  );

  // Nested, to prove the walk is not shallow.
  assert.throws(
    () =>
      diffSnapshot(
        new Map(),
        [untyped({ key: "a", meta: { sizes: [1, 2n] } })],
        (row) => row.key,
      ),
    /row\.meta\.sizes\[1\]/,
  );
});

test("diffSnapshot rejects a non-string key", () => {
  assert.throws(
    () =>
      diffSnapshot(new Map(), [{ key: "a", value: 1 }], (row) =>
        (row.value as unknown as string),
      ),
    /Skip keys must be strings/,
  );
});
