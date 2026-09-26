import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessError } from "./readiness.js";
import {
	EXPECTED_FIXTURE_SET_VERSION,
	PARITY_HASH_ALGORITHM,
	assertParityMatch,
	computeParity,
	loadVendoredParity,
} from "./parity.js";

test("computeParity is order-independent and drops _creationTime", () => {
	const labels = new Map([
		["raw1", "m1"],
		["raw2", "m2"],
	]);
	const a = computeParity(
		[
			{ _id: "raw1", body: "hi", _creationTime: 111 },
			{ _id: "raw2", body: "there", _creationTime: 222 },
		],
		labels,
	);
	const b = computeParity(
		[
			{ _id: "raw2", body: "there", _creationTime: 999 },
			{ _id: "raw1", body: "hi", _creationTime: 1 },
		],
		labels,
	);
	assert.deepEqual(a, b);
});

test("a different mapped row set produces a different hash", () => {
	const labels = new Map([["raw1", "m1"]]);
	const a = computeParity([{ _id: "raw1", body: "hi" }], labels);
	const b = computeParity([{ _id: "raw1", body: "bye" }], labels);
	assert.notEqual(a.contentHash, b.contentHash);
});

test("assertParityMatch reports a harness error, never a mismatch, when two row sets differ", () => {
	const labels = new Map([["raw1", "m1"]]);
	const a = computeParity([{ _id: "raw1", body: "hi" }], labels);
	const b = computeParity([{ _id: "raw1", body: "bye" }], labels);
	assert.throws(() => assertParityMatch("messages", a, b), HarnessError);
	assertParityMatch("messages", a, a); // no throw
});

test("computeParity reproduces the vendored empty-table hash used by every V1-V6 likes table with no likes", () => {
	// A cross-check that this port is bit-for-bit identical to
	// convex-tutorial's fixture.ts `computeParity`: every vector's empty
	// `likes` table hashes to this same constant in `testdata/v1.parity.json`.
	const { contentHash } = computeParity([], new Map());
	const vendored = loadVendoredParity();
	assert.equal(contentHash, vendored.vectors["V1"]!["likes"]!.contentHash);
	assert.equal(contentHash, vendored.vectors["V2"]!["likes"]!.contentHash);
	assert.equal(contentHash, vendored.vectors["V3"]!["likes"]!.contentHash);
	assert.equal(contentHash, vendored.vectors["V4"]!["likes"]!.contentHash);
});

test("loadVendoredParity fails on algorithm or fixture-set-version mismatch", () => {
	assert.equal(loadVendoredParity().hashAlgorithm, PARITY_HASH_ALGORITHM);
	assert.equal(loadVendoredParity().fixtureSetVersion, EXPECTED_FIXTURE_SET_VERSION);
});

test("computeParity reproduces the non-empty V1/V2/V5 golden vectors from raw fixture rows plus labels", () => {
	// Cross-checks the risky paths the empty-likes test cannot reach: label
	// mapping via ID_LIKE_FIELDS (_id plus the room/user/sender/message
	// foreign keys), _creationTime drop, row sort by mapped _id, and key
	// sort. Raw ids are deliberately distinct from labels, input keys are in
	// non-sorted order, and multi-row inputs are fed in reverse so the test
	// fails if mapping or either sort regresses. Expected hashes are the
	// committed goldens in testdata/v1.parity.json (fixture-set 1.0.0).
	const vendored = loadVendoredParity();

	// V1 "dangling sender": one room, user, membership, and message.
	const v1Labels = new Map([
		["raw-room-1", "r"],
		["raw-user-1", "u"],
		["raw-mu-1", "mu"],
		["raw-msg-1", "a"],
	]);
	const rooms = computeParity(
		[{ _creationTime: 5, name: "room", _id: "raw-room-1" }],
		v1Labels,
	);
	assert.equal(rooms.count, 1);
	assert.equal(rooms.contentHash, vendored.vectors["V1"]!["rooms"]!.contentHash);

	const users = computeParity([{ name: "Ada", _id: "raw-user-1", _creationTime: 6 }], v1Labels);
	assert.equal(users.count, 1);
	assert.equal(users.contentHash, vendored.vectors["V1"]!["users"]!.contentHash);

	const memberships = computeParity(
		[{ user: "raw-user-1", _id: "raw-mu-1", active: true, room: "raw-room-1", _creationTime: 7 }],
		v1Labels,
	);
	assert.equal(memberships.count, 1);
	assert.equal(memberships.contentHash, vendored.vectors["V1"]!["memberships"]!.contentHash);

	const messages = computeParity(
		[{ sender: "raw-user-1", body: "one", room: "raw-room-1", _id: "raw-msg-1", _creationTime: 10 }],
		v1Labels,
	);
	assert.equal(messages.count, 1);
	assert.equal(messages.contentHash, vendored.vectors["V1"]!["messages"]!.contentHash);
	assertParityMatch("V1.messages", messages, {
		count: 1,
		contentHash: vendored.vectors["V1"]!["messages"]!.contentHash,
	});

	// V2 "active membership": two messages fed in reverse label order to
	// exercise row sorting by mapped _id.
	const v2Labels = new Map([
		["raw-room-2", "r"],
		["raw-a-2", "a"],
		["raw-b-2", "b"],
		["raw-a1-2", "a1"],
		["raw-b1-2", "b1"],
	]);
	const v2Messages = computeParity(
		[
			{ _id: "raw-b1-2", _creationTime: 19, body: "b", sender: "raw-b-2", room: "raw-room-2" },
			{ _id: "raw-a1-2", _creationTime: 20, body: "a", sender: "raw-a-2", room: "raw-room-2" },
		],
		v2Labels,
	);
	assert.equal(v2Messages.count, 2);
	assert.equal(v2Messages.contentHash, vendored.vectors["V2"]!["messages"]!.contentHash);

	// V5 "deletes": the non-empty likes table, exercising the message and
	// user foreign-key mapping.
	const v5Labels = new Map([
		["raw-a1-5", "a1"],
		["raw-b-5", "b"],
		["raw-l1-5", "l1"],
	]);
	const likes = computeParity(
		[{ user: "raw-b-5", message: "raw-a1-5", _id: "raw-l1-5", _creationTime: 41 }],
		v5Labels,
	);
	assert.equal(likes.count, 1);
	assert.equal(likes.contentHash, vendored.vectors["V5"]!["likes"]!.contentHash);
});

test("loadVendoredParity reports missing, corrupt, and misshapen files as HarnessError", () => {
	const dir = mkdtempSync(join(tmpdir(), "parity-"));

	assert.throws(() => loadVendoredParity(join(dir, "does-not-exist.json")), HarnessError);

	const corrupt = join(dir, "corrupt.json");
	writeFileSync(corrupt, "{ not valid json");
	assert.throws(() => loadVendoredParity(corrupt), HarnessError);

	const misshapen: [string, unknown][] = [
		["not-an-object.json", []],
		["no-vectors.json", { fixtureSetVersion: "1.0.0", hashAlgorithm: PARITY_HASH_ALGORITHM }],
		[
			"vectors-array.json",
			{ fixtureSetVersion: "1.0.0", hashAlgorithm: PARITY_HASH_ALGORITHM, vectors: [] },
		],
		[
			"bad-entry.json",
			{
				fixtureSetVersion: "1.0.0",
				hashAlgorithm: PARITY_HASH_ALGORITHM,
				vectors: { V1: { rooms: { count: "1", contentHash: 42 } } },
			},
		],
	];
	for (const [name, body] of misshapen) {
		const path = join(dir, name);
		writeFileSync(path, JSON.stringify(body));
		assert.throws(() => loadVendoredParity(path), HarnessError, `expected HarnessError for ${name}`);
	}

	// A wrong algorithm or version is still a HarnessError, not a silent load.
	const wrongAlgo = join(dir, "wrong-algo.json");
	writeFileSync(
		wrongAlgo,
		JSON.stringify({ fixtureSetVersion: "1.0.0", hashAlgorithm: "md5", vectors: {} }),
	);
	assert.throws(() => loadVendoredParity(wrongAlgo), HarnessError);
});
