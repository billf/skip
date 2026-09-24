import assert from "node:assert/strict";
import { test } from "node:test";
import { deepFreeze } from "@skipruntime/core";
import type {
  Context,
  DepSafe,
  EagerCollection,
  Json,
  Mapper,
  Values,
} from "@skipruntime/core";
import { buildSnapshotEntries } from "./snapshot.js";
import {
  CONTROL_COMPONENT,
  MARKER_TABLE,
  SplitByTable,
  type RevisionEnvelope,
  type TaggedRow,
} from "./split.js";

/**
 * Builds a `Values<T>` the way a real snapshot publish produces it: one
 * value per row (`Entry<K, V> = [K, V[]]`), so a multi-row query key yields
 * multiple values and `getUnique()` throws on it — exactly like Skip's
 * `SkipNonUniqueValueError`.
 */
function multiValues<T>(items: readonly T[]): Values<T> {
  const frozen = items.map((item) => deepFreeze(item));
  return {
    getUnique: () => {
      if (frozen.length !== 1) {
        throw new Error(`expected exactly one value, got ${frozen.length}`);
      }
      return frozen[0]!;
    },
    toArray: () => [...frozen],
    [Symbol.iterator]: () => frozen[Symbol.iterator](),
  };
}

/**
 * Minimal `EagerCollection` stand-in whose `map` mirrors the real
 * `EagerCollection.map` signature (`Params extends readonly DepSafe[]`, the
 * mapper class instantiated internally), so tests through this stub prove
 * the `.map(SplitByTable, component, deepFreeze(knownTables))` wiring
 * typechecks and runs end-to-end. (A live Skip graph cannot run in this
 * checkout; cf. room_feed.test.ts.)
 */
function mappableSource(
  entries: readonly (readonly [
    string,
    readonly (TaggedRow | RevisionEnvelope)[],
  ])[],
): EagerCollection<string, TaggedRow | RevisionEnvelope> {
  const byKey = new Map(entries.map(([k, vs]) => [k, [...vs]]));
  const getArray = (key: string) =>
    (byKey.get(key) ?? []).map((v) => deepFreeze(v));
  return {
    getArray,
    map<K2 extends Json, V2 extends Json, Params extends readonly DepSafe[]>(
      MapperClass: new (
        ...params: Params
      ) => Mapper<string, TaggedRow | RevisionEnvelope, K2, V2>,
      ...params: Params
    ): EagerCollection<K2, V2> {
      const mapper = new MapperClass(...params);
      const out = new Map<K2, V2[]>();
      for (const [key, vs] of byKey) {
        for (const [k2, v2] of mapper.mapEntry(
          key,
          multiValues(vs),
          noContext,
        )) {
          out.set(k2, [...(out.get(k2) ?? []), v2]);
        }
      }
      return {
        getArray: (key: K2) => [...(out.get(key) ?? [])],
      } as unknown as EagerCollection<K2, V2>;
    },
  } as unknown as EagerCollection<string, TaggedRow | RevisionEnvelope>;
}

const noContext = {} as Context;
const KNOWN_TABLES = new Set(["rooms", "users", "memberships", "messages", "likes"]);

test("split mapper routes each row of a real multi-row snapshot entry to its table, keyed <component>/<table>/<id>", () => {
  const mapper = new SplitByTable("room-feed", KNOWN_TABLES);
  // Build the entry through the real publish path so the Values shape under
  // test is exactly what `writer.update` delivers: one value per row.
  const [entry] = buildSnapshotEntries([
    [
      "q1",
      [
        { table: "messages", doc: { _id: "m1", body: "hi" } },
        { table: "memberships", doc: { _id: "u1-r1" } },
      ],
    ],
  ]);
  const out = [
    ...mapper.mapEntry(entry![0], multiValues(entry![1] as TaggedRow[]), noContext),
  ];
  assert.deepEqual(out, [
    ["room-feed/messages/m1", { _id: "m1", body: "hi" }],
    ["room-feed/memberships/u1-r1", { _id: "u1-r1" }],
  ]);
});

test("split mapper rejects an unknown table with an error", () => {
  const mapper = new SplitByTable("room-feed", KNOWN_TABLES);
  const rows: TaggedRow[] = [{ table: "not-a-table", doc: { _id: "x" } }];
  assert.throws(
    () => [...mapper.mapEntry("q1", multiValues(rows), noContext)],
    /unknown table/,
  );
});

test("marker rows are routed to the control collection regardless of the requested component", () => {
  const mapper = new SplitByTable("room-feed", KNOWN_TABLES);
  const rows: TaggedRow[] = [{ table: MARKER_TABLE, doc: { _id: "seq" } }];
  const out = [...mapper.mapEntry("markers", multiValues(rows), noContext)];
  assert.deepEqual(out, [[`${CONTROL_COMPONENT}/${MARKER_TABLE}/seq`, { _id: "seq" }]]);
});

test("a revision-delta envelope with the same rows produces the same per-table collections as the equivalent snapshot array", () => {
  const snapshotMapper = new SplitByTable("room-feed", KNOWN_TABLES);
  const snapshotRows: TaggedRow[] = [{ table: "messages", doc: { _id: "m1", body: "hi" } }];
  const fromSnapshot = [...snapshotMapper.mapEntry("q1", multiValues(snapshotRows), noContext)];

  const revisionMapper = new SplitByTable("room-feed", KNOWN_TABLES);
  const envelope: RevisionEnvelope = {
    ts: "1",
    deleted: false,
    component: "room-feed",
    table: "messages",
    _id: "m1",
    _creationTime: 100,
    doc: { _id: "m1", body: "hi" },
  };
  const fromRevision = [...revisionMapper.mapEntry("m1", multiValues([envelope]), noContext)];

  assert.deepEqual(fromSnapshot, fromRevision);
});

test("a deleted revision-delta envelope produces no output row", () => {
  const mapper = new SplitByTable("room-feed", KNOWN_TABLES);
  const envelope: RevisionEnvelope = {
    ts: "2",
    deleted: true,
    component: "room-feed",
    table: "messages",
    _id: "m1",
    _creationTime: 100,
    doc: { _id: "m1" },
  };
  const out = [...mapper.mapEntry("m1", multiValues([envelope]), noContext)];
  assert.deepEqual(out, []);
});

test("a revision-delta envelope for another component throws instead of silently mis-routing", () => {
  const mapper = new SplitByTable("room-feed", KNOWN_TABLES);
  const envelope: RevisionEnvelope = {
    ts: "3",
    deleted: false,
    component: "group-probe",
    table: "messages",
    _id: "m1",
    _creationTime: 100,
    doc: { _id: "m1", body: "hi" },
  };
  assert.throws(
    () => [...mapper.mapEntry("m1", multiValues([envelope]), noContext)],
    /does not match mapper component/,
  );
});

test("SplitByTable wires through EagerCollection.map with deepFreeze(knownTables)", () => {
  const source = mappableSource([
    [
      "q1",
      [
        { table: "messages", doc: { _id: "m1", body: "hi" } },
        { table: "memberships", doc: { _id: "u1-r1" } },
      ],
    ],
  ]);
  const split = source.map(
    SplitByTable,
    "room-feed",
    deepFreeze(new Set(["messages", "memberships"])),
  );
  assert.deepEqual(split.getArray("room-feed/messages/m1"), [
    { _id: "m1", body: "hi" },
  ]);
  assert.deepEqual(split.getArray("room-feed/memberships/u1-r1"), [
    { _id: "u1-r1" },
  ]);
});
