import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry, Json } from "@skipruntime/core";
import { applySnapshotBatch, buildSnapshotEntries, type Writer } from "./snapshot.js";

function recorder() {
  const calls: { entries: Entry<Json, Json>[]; isInit: boolean }[] = [];
  const writer: Writer = {
    update: (entries, isInit) => {
      calls.push({ entries, isInit });
      return Promise.resolve();
    },
  };
  return { calls, writer };
}

test("buildSnapshotEntries rejects a duplicate query/page-region key", () => {
  assert.throws(() => {
    buildSnapshotEntries([
      ["query-1", [{ a: 1 }]],
      ["query-1", [{ a: 2 }]],
    ]);
  }, /duplicate key/);
});

test("AE1: a multi-table batch produces exactly one update", async () => {
  const { calls, writer } = recorder();
  const entries = buildSnapshotEntries([
    ["room-feed", [{ table: "messages", doc: { _id: "m1" } }]],
    ["group-probe", [{ table: "memberships", doc: { _id: "u1" } }]],
  ]);
  await applySnapshotBatch(writer, entries, { isInit: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.isInit, false);
  assert.deepEqual(calls[0]!.entries, entries);
});

test("an unchanged key is simply omitted from the batch", async () => {
  const { calls, writer } = recorder();
  const entries = buildSnapshotEntries([["room-feed", [{ table: "messages", doc: {} }]]]);
  await applySnapshotBatch(writer, entries, { isInit: false });
  assert.deepEqual(
    calls[0]!.entries.map(([key]) => key),
    ["room-feed"],
  );
});

test("an emptied query is written as an empty value, not omitted", async () => {
  const { calls, writer } = recorder();
  const entries = buildSnapshotEntries([["room-feed", []]]);
  await applySnapshotBatch(writer, entries, { isInit: false });
  assert.deepEqual(calls[0]!.entries, [["room-feed", []]]);
});

test("isInit: true succeeds when every live key is present", async () => {
  const { calls, writer } = recorder();
  const entries = buildSnapshotEntries([
    ["room-feed", []],
    ["group-probe", []],
  ]);
  await applySnapshotBatch(writer, entries, {
    isInit: true,
    liveKeys: ["room-feed", "group-probe"],
  });
  assert.equal(calls[0]!.isInit, true);
});

test("a partial isInit: true throws and issues no update", async () => {
  const { calls, writer } = recorder();
  const entries = buildSnapshotEntries([["room-feed", []]]);
  await assert.rejects(
    applySnapshotBatch(writer, entries, {
      isInit: true,
      liveKeys: ["room-feed", "group-probe"],
    }),
    /partial isInit/,
  );
  assert.equal(calls.length, 0);
});

test("a duplicate key in the entries array is rejected even outside buildSnapshotEntries", async () => {
  const { writer } = recorder();
  await assert.rejects(
    applySnapshotBatch(
      writer,
      [
        ["room-feed", []],
        ["room-feed", []],
      ],
      { isInit: false },
    ),
    /duplicate key/,
  );
});
