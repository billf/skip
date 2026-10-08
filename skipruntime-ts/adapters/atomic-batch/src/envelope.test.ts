import assert from "node:assert/strict";
import { test } from "node:test";
import { deepFreeze } from "@skipruntime/core";
import type { Context, Json, Values } from "@skipruntime/core";
import {
  envelopeDoc,
  isRevisionEnvelope,
  toEnvelope,
  unwrapEntry,
  type EnvelopeDoc,
  type RevisionChange,
  type RevisionDeltaEntry,
  type RevisionEnvelope,
} from "./envelope.js";
import { RevisionDeltaSource } from "./revision_delta.js";
import { SplitByTable, type TaggedRow } from "./split.js";

type Doc = { _id: string; body: string };

const upsert = (
  over: Partial<{ ts: string | bigint; _id: string; body: string }> = {},
): RevisionDeltaEntry<Doc> => ({
  ts: over.ts ?? "10",
  deleted: false,
  component: "chat",
  table: "messages",
  _id: over._id ?? "m1",
  _creationTime: 1,
  doc: { _id: over._id ?? "m1", body: over.body ?? "hi" },
});

const tombstone = (
  ts: string | bigint,
  _id = "m1",
): RevisionDeltaEntry<Doc> => ({
  ts,
  deleted: true,
  component: "chat",
  table: "messages",
  _id,
  _creationTime: 1,
  doc: null,
});

function valuesOf<T>(items: readonly T[]): Values<T> {
  const frozen = items.map((item) => deepFreeze(item));
  return {
    getUnique: () => {
      if (frozen.length !== 1) throw new Error("expected exactly one value");
      return frozen[0]!;
    },
    toArray: () => [...frozen],
    [Symbol.iterator]: () => frozen[Symbol.iterator](),
  };
}

const noContext = {} as Context;

/** Runs published changes through `SplitByTable`, as a consumer's graph would. */
function splitAll(changes: readonly RevisionChange<Doc>[]): [string, Json][] {
  const mapper = new SplitByTable("chat", new Set(["messages"]));
  return changes.flatMap(([key, envelopes]) => [
    ...mapper.mapEntry(
      key,
      valuesOf<TaggedRow | RevisionEnvelope>(envelopes),
      noContext,
    ),
  ]);
}

test("toEnvelope canonicalizes ts so equivalent spellings publish identically", () => {
  const spellings = ["7", "007", 7n] as const;
  const published = spellings.map((ts) => toEnvelope(upsert({ ts })).ts);
  assert.deepEqual(published, ["7", "7", "7"]);
  // Above 2^53 the string stays exact (a plain number would round it).
  assert.equal(
    toEnvelope(upsert({ ts: "9007199254740993" })).ts,
    "9007199254740993",
  );
  assert.throws(
    () => toEnvelope(upsert({ ts: "0x10" })),
    /invalid revision timestamp/,
  );
});

test("an envelope is a plain JSON value: it survives a JSON round trip unchanged", () => {
  for (const entry of [upsert(), tombstone("20")]) {
    const envelope = toEnvelope(entry);
    assert.deepEqual(JSON.parse(JSON.stringify(envelope)), envelope);
  }
});

test("Envelope<T> -> T helpers recover the document and the entry's documents", () => {
  const envelope = toEnvelope(upsert({ body: "x" }));
  // Type-level: the document type flows back out of the envelope.
  const doc: EnvelopeDoc<typeof envelope> = { _id: "m1", body: "x" };
  assert.deepEqual(envelopeDoc(envelope), doc);
  assert.equal(envelopeDoc(toEnvelope(tombstone("20"))), null);

  const change: RevisionChange<Doc> = ["k", [envelope]];
  assert.deepEqual(unwrapEntry(change), ["k", [doc]]);
  assert.deepEqual(unwrapEntry(["k", []]), ["k", []]);
});

test("the discriminated union rejects a typed upsert without a doc and a tombstone with one", () => {
  // @ts-expect-error deleted:false requires a document
  const noDoc: RevisionDeltaEntry<Doc> = { ...upsert(), doc: null };
  // @ts-expect-error deleted:true requires doc:null
  const withDoc: RevisionDeltaEntry<Doc> = {
    ...tombstone("2"),
    doc: { _id: "m1", body: "x" },
  };
  // Untyped input is still rejected at runtime.
  const source = new RevisionDeltaSource<Doc>();
  const gen = source.beginGeneration();
  assert.throws(() => source.applyEntry(gen, noDoc), /non-null doc/);
  assert.throws(() => source.applyEntry(gen, withDoc), /requires doc:null/);
});

test("isRevisionEnvelope tells an envelope from a snapshot TaggedRow", () => {
  assert.equal(isRevisionEnvelope(toEnvelope(upsert())), true);
  const tagged: TaggedRow = { table: "messages", doc: { _id: "m1" } };
  assert.equal(isRevisionEnvelope(tagged), false);
});

test("applyGroup's published payload feeds SplitByTable directly, with no reshaping", async () => {
  const source = new RevisionDeltaSource<Doc>();
  const gen = source.beginGeneration();
  assert.equal(
    (
      await source.applyGroup(gen, source.beginPage(gen, ["g10"])!, "g10", [
        upsert(),
      ])
    ).status,
    "applied",
  );
  assert.equal(source.promote(gen), true);

  const batches: RevisionChange<Doc>[][] = [];
  const publish = async (changes: RevisionChange<Doc>[]) =>
    void batches.push(changes);

  await source.applyGroup(
    gen,
    source.beginPage(gen, ["g20"])!,
    "g20",
    [upsert({ ts: "20", body: "edited" }), upsert({ ts: "20", _id: "m2" })],
    publish,
  );
  assert.deepEqual(splitAll(batches[0]!), [
    ["chat/messages/m1", { _id: "m1", body: "edited" }],
    ["chat/messages/m2", { _id: "m2", body: "hi" }],
  ]);
});

test("a tombstone publishes an empty value list (a Skip delete) and leaves nothing for SplitByTable", async () => {
  const source = new RevisionDeltaSource<Doc>();
  const gen = source.beginGeneration();
  await source.applyGroup(gen, source.beginPage(gen, ["g10"])!, "g10", [
    upsert(),
  ]);
  assert.equal(source.promote(gen), true);

  const batches: RevisionChange<Doc>[][] = [];
  await source.applyGroup(
    gen,
    source.beginPage(gen, ["g20"])!,
    "g20",
    [tombstone("20")],
    async (changes) => void batches.push(changes),
  );
  assert.deepEqual(batches, [[["chat\u0000messages\u0000m1", []]]]);
  assert.deepEqual(splitAll(batches[0]!), []);
  assert.equal(source.currentSnapshot.has("chat\u0000messages\u0000m1"), false);
});

test("promoteWith publishes the snapshot as envelopes, which SplitByTable reads as an init", async () => {
  const source = new RevisionDeltaSource<Doc>();
  const gen = source.beginGeneration();
  await source.applyGroup(gen, source.beginPage(gen, ["g10"])!, "g10", [
    upsert(),
    upsert({ _id: "m2" }),
    tombstone("10", "m3"),
  ]);
  const batches: RevisionChange<Doc>[][] = [];
  assert.equal(
    await source.promoteWith(
      gen,
      async (changes) => void batches.push(changes),
    ),
    true,
  );
  assert.deepEqual(
    splitAll(batches[0]!)
      .map(([key]) => key)
      .sort(),
    ["chat/messages/m1", "chat/messages/m2"],
  );
});
