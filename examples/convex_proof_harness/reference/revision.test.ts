/**
 * U15's `RevisionDeltaReferenceSource` output, fed through the real
 * `SplitByTable` mapper (the same one `service.ts`'s `createReferenceService`
 * wires into the graph), without a Skip runtime. Exists because a live
 * `npm run reference:revision` run once failed with `unknown table
 * "undefined"`: `RevisionDeltaSource.applyEntry`'s returned `change` is the
 * bare doc (`[key, [doc]]`), not the `RevisionEnvelope` shape `SplitByTable`
 * needs to route by table -- a shape mismatch `Entry<Json, Json>`'s width
 * hid from `tsc`. This test would have caught it without a live deployment.
 * docs/plans/2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U15.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context, Json, Values } from "@skipruntime/core";
import { deepFreeze } from "@skipruntime/core";
import { SplitByTable, type TaggedRow, type RevisionEnvelope } from "@skip-adapter/atomic-batch";
import { CheckpointEmitter } from "../src/checkpoint.js";
import { RevisionDeltaReferenceSource, type ScriptedRow } from "./revision.js";
import { SOURCE_COMPONENT, ALL_SELECTED_ROWS_RESOURCE } from "./service.js";

const KNOWN_TABLES = deepFreeze(new Set(["rooms", "users", "memberships", "messages", "likes"]));

function fakeValues<T>(items: readonly T[]): Values<T> {
	const arr = items as (T & { readonly __depSafe?: never })[];
	return {
		[Symbol.iterator]: () => arr[Symbol.iterator](),
		getUnique: () => {
			if (arr.length !== 1) throw new Error(`expected exactly one value, got ${arr.length}`);
			return arr[0]!;
		},
		toArray: () => [...arr],
	} as Values<T>;
}

async function collectUpdates(rows: ScriptedRow[]): Promise<[Json, Json[]][]> {
	const emitter = new CheckpointEmitter();
	const source = new RevisionDeltaReferenceSource(emitter);
	const updates: [Json, Json[]][] = [];
	await source.subscribe("instance-1", ALL_SELECTED_ROWS_RESOURCE, {}, {
		update: async (entries) => {
			for (const entry of entries) updates.push(entry as [Json, Json[]]);
		},
		error: (error) => {
			throw error;
		},
	});
	await source.applyGroup({ ts: 1, rows });
	return updates;
}

test("applyGroup's published entries route through SplitByTable without error, one per table", async () => {
	const rows: ScriptedRow[] = [
		{ table: "rooms", _id: "room-1", _creationTime: 1, doc: { _id: "room-1", _creationTime: 1, name: "room" } },
		{
			table: "messages",
			_id: "message-1",
			_creationTime: 50,
			doc: { _id: "message-1", _creationTime: 50, room: "room-1", sender: "user-1", body: "hi" },
		},
	];
	const updates = await collectUpdates(rows);
	assert.equal(updates.length, 2);

	const split = new SplitByTable(SOURCE_COMPONENT, KNOWN_TABLES);
	const routed = new Map<string, Json>();
	for (const [key, values] of updates) {
		const envelopeValues = values as unknown as (TaggedRow | RevisionEnvelope)[];
		for (const [outKey, doc] of split.mapEntry(key as string, fakeValues(envelopeValues), undefined as unknown as Context)) {
			routed.set(outKey, doc);
		}
	}
	assert.equal(routed.size, 2);
	assert.ok([...routed.keys()].some((k) => k.includes("/rooms/room-1")), "rooms row routed");
	assert.ok([...routed.keys()].some((k) => k.includes("/messages/message-1")), "messages row routed");
});

test("a replayed group's entries never reach the subscriber, so SplitByTable never even sees them", async () => {
	const rows: ScriptedRow[] = [
		{ table: "rooms", _id: "room-2", _creationTime: 1, doc: { _id: "room-2", _creationTime: 1, name: "room" } },
	];
	const emitter = new CheckpointEmitter();
	const source = new RevisionDeltaReferenceSource(emitter);
	let updateCount = 0;
	await source.subscribe("instance-1", ALL_SELECTED_ROWS_RESOURCE, {}, {
		update: async () => {
			updateCount += 1;
		},
		error: (error) => {
			throw error;
		},
	});
	// subscribe()'s own initial `update([], true)` counts as update #1.
	await source.applyGroup({ ts: 1, rows });
	assert.equal(updateCount, 2);
	const result = await source.applyGroup({ ts: 1, rows });
	assert.equal(result.replayedIgnored, 1);
	assert.equal(updateCount, 2, "a fully-replayed group must not push an empty/duplicate update");
});
