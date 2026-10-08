import assert from "node:assert/strict";
import { test } from "node:test";
import { RevisionDeltaApplier, RevisionDeltaSource, compareTs, revisionKey, type RevisionDeltaEntry } from "./revision_delta.js";

function entry(over: Partial<RevisionDeltaEntry<{ body: string }>> = {}): RevisionDeltaEntry<{ body: string }> {
	return {
		ts: "10",
		deleted: false,
		component: "chat",
		table: "messages",
		_id: "m1",
		_creationTime: 1,
		doc: { body: "hi" },
		...over,
	};
}

test("timestamps above 2^53 stay distinct and ordered", () => {
	const a = "9007199254740992"; // 2^53
	const b = "9007199254740993"; // 2^53 + 1, not representable exactly as a double
	assert.notEqual(a, b);
	// A plain Number conversion rounds b down to a, conflating two distinct timestamps.
	assert.equal(Number(a), Number(b));
	// compareTs, going through BigInt, keeps them distinct and ordered.
	assert.equal(compareTs(a, b), -1);
	assert.equal(compareTs(b, a), 1);
	assert.equal(compareTs(a, a), 0);
});

test("the applier itself keeps adjacent above-2^53 timestamps distinct and ordered", () => {
	const applier = new RevisionDeltaApplier<{ body: string }>();
	applier.apply(entry({ ts: "9007199254740992" }));
	// A replay at "9007199254740993" (one tick later, but rounded down to
	// the same double as the retained ts by Number conversion) must still
	// be treated as strictly newer, not as a replay of the same instant.
	const next = applier.apply(entry({ ts: "9007199254740993", doc: { body: "next" } }));
	assert.notEqual(next, undefined);
	assert.equal(applier.replayedIgnored, 0);
});

test("a replayed older ts is ignored and counted (AE2)", () => {
	const applier = new RevisionDeltaApplier<{ body: string }>();
	const first = applier.apply(entry({ ts: "10" }));
	assert.notEqual(first, undefined);
	const replay = applier.apply(entry({ ts: "5" }));
	assert.equal(replay, undefined);
	assert.equal(applier.replayedIgnored, 1);
});

test("an upsert followed by a tombstone cannot be resurrected by a replayed older upsert", () => {
	const applier = new RevisionDeltaApplier<{ body: string }>();
	applier.apply(entry({ ts: "10", deleted: false }));
	const tombstone = applier.apply(entry({ ts: "20", deleted: true, doc: null }));
	assert.deepEqual(tombstone, ["chat\u0000messages\u0000m1", []]);

	// A replayed (older) upsert must not resurrect the deleted row.
	const replay = applier.apply(entry({ ts: "10", deleted: false }));
	assert.equal(replay, undefined, "replay must be ignored, not resurrect the tombstone");
});

test("sweepTombstones discards retained tombstones at or under the horizon", () => {
	const applier = new RevisionDeltaApplier<{ body: string }>();
	applier.apply(entry({ ts: "10", deleted: true, doc: null }));
	assert.equal(applier.retainedSize, 1);
	applier.sweepTombstones("5");
	assert.equal(applier.retainedSize, 1, "horizon before the tombstone's ts must not sweep it");
	applier.sweepTombstones("10");
	assert.equal(applier.retainedSize, 0);
});

test("RevisionDeltaSource: failure before the first group, between groups, and after the final update but before the cursor replays with no loss and no double apply", () => {
	const source = new RevisionDeltaSource<{ body: string }>();
	const gen = source.beginGeneration();
	const ledger = source.beginPage(gen, ["g1", "g2"])!;

	// Failure before the first group: nothing applied yet, replay from scratch is a no-op difference.
	let result = source.applyEntry(gen, entry({ ts: "10", _id: "m1" }));
	assert.equal(result.status, "applied");
	source.markGroupComplete(gen, ledger, "g1");

	// Failure between groups: replaying g1's already-applied entry must not double-apply.
	result = source.applyEntry(gen, entry({ ts: "10", _id: "m1" }));
	assert.equal(result.status, "replay-ignored");

	result = source.applyEntry(gen, entry({ ts: "11", _id: "m2", doc: { body: "second" } }));
	assert.equal(result.status, "applied");
	source.markGroupComplete(gen, ledger, "g2");

	// Failure after the final update but before the cursor (promote) is set:
	// the page is complete, but nothing is visible until promote runs.
	assert.equal(source.currentSnapshot.size, 0);
	assert.equal(source.promote(gen), true);
	assert.equal(source.currentSnapshot.size, 2);

	// A second promote (simulating a retried "set the cursor" step) must not
	// be required to recover -- and the source never double-applies.
	assert.equal(source.replayedIgnored(gen), 1);
});

test("a cold multi-page snapshot publishes nothing partial and promotes once; a second replacement restarts only the candidate", () => {
	const source = new RevisionDeltaSource<{ body: string }>();
	const gen1 = source.beginGeneration();
	const page1 = source.beginPage(gen1, ["g1"])!;
	source.applyEntry(gen1, entry({ _id: "m1", ts: "1" }));
	source.markGroupComplete(gen1, page1, "g1");
	assert.equal(source.currentSnapshot.size, 0, "nothing partial published before promotion");

	// A second replacement begins before gen1 promotes.
	const gen2 = source.beginGeneration();
	assert.equal(source.isCurrentGeneration(gen1), false);
	assert.equal(source.promote(gen1), false, "stale generation cannot promote");

	const page2 = source.beginPage(gen2, ["g1"])!;
	source.applyEntry(gen2, entry({ _id: "m1", ts: "1" }));
	source.markGroupComplete(gen2, page2, "g1");
	assert.equal(source.promote(gen2), true);
	assert.equal(source.currentSnapshot.size, 1);
});

test("a late event from an old generation is dropped", () => {
	const source = new RevisionDeltaSource<{ body: string }>();
	const gen1 = source.beginGeneration();
	source.beginGeneration(); // supersedes gen1
	const result = source.applyEntry(gen1, entry());
	assert.equal(result.status, "late-generation-dropped");
	assert.equal(source.lateEventDropCount > 0, true);
});

test("delete -> sweep -> older replay stays ignored (watermark survives GC)", () => {
	const applier = new RevisionDeltaApplier<{ body: string }>();
	applier.apply(entry({ ts: "10", deleted: false }));
	applier.apply(entry({ ts: "20", deleted: true, doc: null }));
	applier.sweepTombstones("20");
	assert.equal(applier.retainedSize, 0);
	// A replayed older upsert must not resurrect the swept tombstone.
	const replay = applier.apply(entry({ ts: "10", deleted: false }));
	assert.equal(replay, undefined);
	assert.equal(applier.replayedIgnored, 1);
	// A strictly newer write past the watermark still applies.
	const next = applier.apply(entry({ ts: "30", deleted: false, doc: { body: "new" } }));
	assert.notEqual(next, undefined);
});

test("RevisionDeltaSource.sweepTombstones passthrough sweeps the live generation and ignores stale ids", () => {
	const source = new RevisionDeltaSource<{ body: string }>();
	const gen = source.beginGeneration();
	source.beginPage(gen, ["g1"]);
	assert.equal(source.applyEntry(gen, entry({ ts: "20", deleted: true, doc: null })).status, "applied");
	assert.equal(source.sweepTombstones(gen, "20"), true);
	// Older replay through the source stays ignored after the sweep.
	const replay = source.applyEntry(gen, entry({ ts: "10", deleted: false }));
	assert.equal(replay.status, "replay-ignored");

	const stale = gen;
	source.beginGeneration(); // supersedes `gen`
	assert.equal(source.sweepTombstones(stale, "20"), false);
});

test("apply rejects a live entry with doc:null and a tombstone with non-null doc before retaining", () => {
	const applier = new RevisionDeltaApplier<{ body: string }>();
	assert.throws(() => applier.apply(entry({ deleted: false, doc: null })), /deleted:false requires a non-null doc/);
	assert.throws(() => applier.apply(entry({ deleted: true, doc: { body: "x" } })), /deleted:true requires doc:null/);
	// Nothing was retained: a valid entry at the same ts still applies.
	const valid = applier.apply(entry({ ts: "10", deleted: false }));
	assert.notEqual(valid, undefined);
	assert.equal(applier.replayedIgnored, 0);
});

test("re-promoting the already-promoted current generation through the source is idempotent", () => {
	const source = new RevisionDeltaSource<{ body: string }>();
	const gen = source.beginGeneration();
	const ledger = source.beginPage(gen, ["g1"])!;
	source.applyEntry(gen, entry({ ts: "1" }));
	source.markGroupComplete(gen, ledger, "g1");
	assert.equal(source.promote(gen), true);
	assert.equal(source.promote(gen), true, "second promote (cursor-commit retry) must not throw");
	assert.equal(source.currentSnapshot.size, 1);
});

test("applyEntry on a promoted generation throws without advancing its watermark", () => {
	const source = new RevisionDeltaSource<{ body: string }>();
	const gen = source.beginGeneration();
	const ledger = source.beginPage(gen, ["g1"])!;
	source.applyEntry(gen, entry({ ts: "10" }));
	source.markGroupComplete(gen, ledger, "g1");
	assert.equal(source.promote(gen), true);

	const newer = entry({ ts: "20", doc: { body: "after promotion" } });
	assert.throws(() => source.applyEntry(gen, newer), /promoted/);
	// A rejected entry must leave no trace: retrying it is rejected the same
	// way, not silently reported as a replay of a revision that was never
	// published.
	assert.throws(() => source.applyEntry(gen, newer), /promoted/);
	assert.equal(source.replayedIgnored(gen), 0);
	assert.deepEqual(source.currentSnapshot.get("chat\u0000messages\u0000m1"), [{ body: "hi" }]);
});

test("duplicate markGroupComplete is a no-op returning true; stale marks return false and are counted", () => {
	const source = new RevisionDeltaSource<{ body: string }>();
	const gen = source.beginGeneration();
	const ledger = source.beginPage(gen, ["g1"])!;
	assert.equal(source.markGroupComplete(gen, ledger, "g1"), true);
	assert.equal(source.markGroupComplete(gen, ledger, "g1"), true, "duplicate mark must be a no-op");
	assert.equal(ledger.isComplete, true);

	const dropsBefore = source.lateEventDropCount;
	source.beginGeneration(); // supersedes `gen`
	assert.equal(source.markGroupComplete(gen, ledger, "g1"), false);
	assert.equal(source.lateEventDropCount, dropsBefore + 1, "stale mark must be counted as a late drop");
});

test("query-only staleness checks never increment the late-drop counter", () => {
	const source = new RevisionDeltaSource<{ body: string }>();
	const gen1 = source.beginGeneration();
	source.beginGeneration(); // supersedes gen1
	assert.equal(source.lateEventDropCount, 0);
	assert.equal(source.isCurrentGeneration(gen1), false);
	assert.equal(source.replayedIgnored(gen1), 0);
	assert.equal(source.currentSnapshot.size, 0);
	assert.equal(source.lateEventDropCount, 0, "queries must not count");
});

test("compareTs and the applier reject malformed timestamps with an Error carrying context", () => {
	assert.throws(() => compareTs("not-a-number", "10"), Error);
	assert.throws(() => compareTs("10", "not-a-number"), Error);
	try {
		compareTs("abc", "10");
		assert.fail("must throw");
	} catch (error) {
		assert.ok(error instanceof Error);
		assert.ok(!(error instanceof SyntaxError), "must not leak a raw SyntaxError");
	}
	const applier = new RevisionDeltaApplier<{ body: string }>();
	assert.throws(() => applier.apply(entry({ ts: "bogus" })), /m1/, "entry failure must carry key/entry context");
	assert.throws(() => applier.sweepTombstones("bogus"), Error);
});

// --- G1: CDC applied to the promoted (live) generation ----------------------

type Doc = { body: string };
const KEY_M1 = "chat\u0000messages\u0000m1";

/** A cold build of `m1` at ts 10, promoted, so the source has a live generation. */
function liveSource(): { source: RevisionDeltaSource<Doc>; gen: number } {
	const source = new RevisionDeltaSource<Doc>();
	const gen = source.beginGeneration();
	const ledger = source.beginPage(gen, ["g10"])!;
	source.applyEntry(gen, entry({ ts: "10" }));
	source.markGroupComplete(gen, ledger, "g10");
	assert.equal(source.promote(gen), true);
	return { source, gen };
}

/** A `publish` callback that records every batch it was handed. */
function recorder(): { batches: unknown[][]; publish: (changes: unknown[]) => Promise<void> } {
	const batches: unknown[][] = [];
	return { batches, publish: async (changes) => void batches.push(changes) };
}

test("live CDC: applyGroup publishes the group once and commits only after publish resolves", async () => {
	const { source, gen } = liveSource();
	assert.equal(source.isLive(gen), true);
	assert.equal(source.liveGeneration, gen);
	const ledger = source.beginPage(gen, ["g20"]);
	assert.ok(ledger, "beginPage on the live generation returns a ledger instead of throwing");

	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const published: unknown[][] = [];
	const pending = source.applyGroup(gen, ledger, "g20", [entry({ ts: "20", doc: { body: "edited" } })], async (changes) => {
		published.push(changes);
		await gate;
	});
	// While Skip has not yet accepted the update, nothing is committed.
	await Promise.resolve();
	assert.deepEqual(published, [[[KEY_M1, [{ body: "edited" }]]]]);
	assert.deepEqual(source.currentSnapshot.get(KEY_M1), [{ body: "hi" }]);
	assert.equal(ledger.isComplete, false);

	release();
	const result = await pending;
	assert.equal(result.status, "applied");
	assert.deepEqual(source.currentSnapshot.get(KEY_M1), [{ body: "edited" }]);
	assert.equal(ledger.isComplete, true);
});

test("live CDC: a rejected publish commits nothing, so the same group applies again", async () => {
	const { source, gen } = liveSource();
	const groupEntries = [entry({ ts: "20", doc: { body: "edited" } })];
	const first = source.beginPage(gen, ["g20"])!;
	await assert.rejects(
		source.applyGroup(gen, first, "g20", groupEntries, async () => {
			throw new Error("skip rejected the update");
		}),
		/skip rejected/,
	);
	assert.deepEqual(source.currentSnapshot.get(KEY_M1), [{ body: "hi" }]);
	assert.equal(first.isComplete, false);

	const { batches, publish } = recorder();
	const retry = source.beginPage(gen, ["g20"])!;
	const result = await source.applyGroup(gen, retry, "g20", groupEntries, publish);
	assert.equal(result.status, "applied");
	assert.equal(batches.length, 1, "the retried group is applied, not ignored as a replay");
	assert.deepEqual(source.currentSnapshot.get(KEY_M1), [{ body: "edited" }]);
});

test("live CDC: a checkpointed group replayed on the live generation is ignored without publishing", async () => {
	const { source, gen } = liveSource();
	const { batches, publish } = recorder();
	const groupEntries = [entry({ ts: "20", doc: { body: "edited" } })];
	await source.applyGroup(gen, source.beginPage(gen, ["g20"])!, "g20", groupEntries, publish);
	const replayLedger = source.beginPage(gen, ["g20"])!;
	const replay = await source.applyGroup(gen, replayLedger, "g20", groupEntries, publish);
	assert.equal(replay.status, "applied");
	assert.equal(replay.status === "applied" && replay.replayIgnored, 1);
	assert.equal(batches.length, 1, "publish is not called for a group with no changes");
	assert.equal(replayLedger.isComplete, true, "an all-replay group still completes its ledger");
});

test("live CDC: a tombstone removes the key, a replayed older upsert cannot resurrect it, and sweeping keeps the watermark", async () => {
	const { source, gen } = liveSource();
	const { batches, publish } = recorder();
	await source.applyGroup(gen, source.beginPage(gen, ["g20"])!, "g20", [entry({ ts: "20", deleted: true, doc: null })], publish);
	assert.deepEqual(batches, [[[KEY_M1, []]]]);
	assert.equal(source.currentSnapshot.has(KEY_M1), false);

	const replay = await source.applyGroup(gen, source.beginPage(gen, ["g10"])!, "g10", [entry({ ts: "10" })], publish);
	assert.equal(replay.status === "applied" && replay.replayIgnored, 1);
	assert.equal(source.currentSnapshot.has(KEY_M1), false);

	assert.equal(source.retainedSize(gen), 1);
	assert.equal(source.sweepTombstones(gen, "20"), true);
	assert.equal(source.retainedSize(gen), 0);
	const afterSweep = await source.applyGroup(gen, source.beginPage(gen, ["g15"])!, "g15", [entry({ ts: "15" })], publish);
	assert.equal(afterSweep.status === "applied" && afterSweep.replayIgnored, 1, "the swept watermark still blocks old replays");
	assert.equal(batches.length, 1);
});

test("live CDC: adjacent timestamps above 2^53 apply in order", async () => {
	const { source, gen } = liveSource();
	const { publish } = recorder();
	const a = "1759300000001000101";
	const b = "1759300000001000102";
	assert.equal(Number(a), Number(b));
	const ledger = source.beginPage(gen, [a, b])!;
	await source.applyGroup(gen, ledger, a, [entry({ ts: a, doc: { body: "edit 1" } })], publish);
	await source.applyGroup(gen, ledger, b, [entry({ ts: b, doc: { body: "edit 2" } })], publish);
	assert.deepEqual(source.currentSnapshot.get(KEY_M1), [{ body: "edit 2" }]);
	assert.equal(ledger.isComplete, true);
});

test("live CDC: applyGroup and beginPage for a superseded generation are dropped and counted", async () => {
	const { source, gen } = liveSource();
	const ledger = source.beginPage(gen, ["g20"])!;
	source.beginGeneration(); // supersedes the live generation
	const before = source.lateEventDropCount;
	const { batches, publish } = recorder();
	const result = await source.applyGroup(gen, ledger, "g20", [entry({ ts: "20" })], publish);
	assert.equal(result.status, "late-generation-dropped");
	assert.equal(source.beginPage(gen, ["g21"]), undefined);
	assert.equal(source.lateEventDropCount, before + 2);
	assert.equal(batches.length, 0);
});

test("a live group with changes but no publish callback throws instead of committing unpublished state", async () => {
	const { source, gen } = liveSource();
	await assert.rejects(source.applyGroup(gen, source.beginPage(gen, ["g20"])!, "g20", [entry({ ts: "20" })]), /publish/);
	assert.deepEqual(source.currentSnapshot.get(KEY_M1), [{ body: "hi" }]);
});

test("staging applyGroup commits into the candidate, never publishes, and marks the group", async () => {
	const source = new RevisionDeltaSource<Doc>();
	const gen = source.beginGeneration();
	const { batches, publish } = recorder();
	const ledger = source.beginPage(gen, ["g10"])!;
	const result = await source.applyGroup(gen, ledger, "g10", [entry({ ts: "10" })], publish);
	assert.equal(result.status, "applied");
	assert.equal(batches.length, 0, "a staging generation publishes nothing partial");
	assert.equal(ledger.isComplete, true);
	assert.equal(source.currentSnapshot.size, 0);
	assert.deepEqual(source.stateEntries(gen), [[KEY_M1, [{ body: "hi" }]]]);
});

test("an empty page takes no ledger: a build with no pages promotes with an empty snapshot", () => {
	const source = new RevisionDeltaSource<Doc>();
	const gen = source.beginGeneration();
	assert.equal(source.promote(gen), true);
	assert.equal(source.currentSnapshot.size, 0);
	assert.equal(source.isLive(gen), true);
});

test("abandonIncompletePages unblocks promotion; the resent page's staged entries are ignored as replays", async () => {
	const source = new RevisionDeltaSource<Doc>();
	const gen = source.beginGeneration();
	const cut = source.beginPage(gen, ["g10", "g11"])!;
	await source.applyGroup(gen, cut, "g10", [entry({ ts: "10" })]);
	// The connection drops before g11: this ledger can never complete.
	assert.throws(() => source.promote(gen), /incomplete/);
	assert.equal(source.abandonIncompletePages(gen), true);

	const resent = source.beginPage(gen, ["g10", "g11"])!;
	const again = await source.applyGroup(gen, resent, "g10", [entry({ ts: "10" })]);
	assert.equal(again.status === "applied" && again.replayIgnored, 1);
	await source.applyGroup(gen, resent, "g11", [entry({ ts: "11", _id: "m2", doc: { body: "second" } })]);
	assert.equal(source.promote(gen), true);
	assert.equal(source.currentSnapshot.size, 2);
});

test("promoteWith publishes the whole candidate in one call, then promotes; a rejected publish leaves state for a retry", async () => {
	const source = new RevisionDeltaSource<Doc>();
	const gen = source.beginGeneration();
	const ledger = source.beginPage(gen, ["g10"])!;
	await source.applyGroup(gen, ledger, "g10", [entry({ ts: "10" }), entry({ ts: "10", _id: "m2", doc: { body: "b" } })]);

	await assert.rejects(source.promoteWith(gen, async () => {
		throw new Error("skip rejected init");
	}), /rejected init/);
	assert.equal(source.isLive(gen), false);
	assert.equal(source.currentSnapshot.size, 0);

	const { batches, publish } = recorder();
	assert.equal(await source.promoteWith(gen, publish), true);
	assert.equal(batches.length, 1);
	assert.equal(batches[0]!.length, 2);
	assert.equal(source.isLive(gen), true);
	assert.equal(await source.promoteWith(gen, publish), true, "re-promoting is idempotent and does not republish");
	assert.equal(batches.length, 1);
});

test("promote leaves tombstoned keys out of the published snapshot", async () => {
	const source = new RevisionDeltaSource<Doc>();
	const gen = source.beginGeneration();
	const ledger = source.beginPage(gen, ["g10", "g20"])!;
	await source.applyGroup(gen, ledger, "g10", [entry({ ts: "10" })]);
	await source.applyGroup(gen, ledger, "g20", [entry({ ts: "20", deleted: true, doc: null })]);
	assert.equal(source.promote(gen), true);
	assert.equal(source.currentSnapshot.has(KEY_M1), false);
	assert.equal(source.currentSnapshot.size, 0);
});

test("revisionKey is the input key the source publishes", () => {
	assert.equal(revisionKey({ component: "chat", table: "messages", _id: "m1" }), KEY_M1);
});

// --- G2: replacement candidates cloned from last-good ------------------------

const MESSAGES = { component: "chat", table: "messages" };
const LIKES = { component: "chat", table: "likes" };
const KEY_L1 = "chat\u0000likes\u0000l1";

/** A live generation holding message m1 (ts 10) and like l1 (ts 11). */
async function liveTwoTables(): Promise<{ source: RevisionDeltaSource<Doc>; live: number }> {
	const source = new RevisionDeltaSource<Doc>();
	const live = source.beginGeneration();
	const ledger = source.beginPage(live, ["g10"])!;
	await source.applyGroup(live, ledger, "g10", [entry({ ts: "10" }), entry({ ts: "11", table: "likes", _id: "l1", doc: { body: "like" } })]);
	assert.equal(source.promote(live), true);
	return { source, live };
}

test("beginReplacement clones live minus the truncated tables and leaves the published snapshot alone", async () => {
	const { source, live } = await liveTwoTables();
	const candidate = source.beginReplacement([MESSAGES]);
	assert.notEqual(candidate, live);
	assert.equal(source.candidateGeneration, candidate);
	assert.deepEqual(source.stateEntries(candidate), [[KEY_L1, [{ body: "like" }]]]);
	// Last-good stays published, unchanged, until the candidate promotes.
	assert.deepEqual(source.currentSnapshot.get(KEY_M1), [{ body: "hi" }]);
	assert.deepEqual(source.currentSnapshot.get(KEY_L1), [{ body: "like" }]);
	// The candidate is the single write target: the old live id is fenced.
	assert.equal(source.isLive(live), false);
	assert.equal(source.isCurrentGeneration(candidate), true);
	const drops = source.lateEventDropCount;
	assert.equal(source.truncate(live, [LIKES]), false, "truncating the fenced live id is a late drop, not a write");
	assert.equal(source.lateEventDropCount, drops + 1);
});

test("a truncated table's rows re-apply at their old timestamps; untouched tables still ignore old replays", async () => {
	const { source } = await liveTwoTables();
	const candidate = source.beginReplacement([MESSAGES]);
	const ledger = source.beginPage(candidate, ["r1"])!;
	const result = await source.applyGroup(candidate, ledger, "r1", [
		entry({ ts: "10", doc: { body: "re-imported" } }), // same ts as the truncated original
		entry({ ts: "11", table: "likes", _id: "l1", doc: { body: "like" } }), // replay of an untouched table
	]);
	assert.equal(result.status === "applied" && result.replayIgnored, 1);
	assert.deepEqual(new Map(source.stateEntries(candidate)), new Map([
		[KEY_M1, [{ body: "re-imported" }]],
		[KEY_L1, [{ body: "like" }]],
	]));
});

test("a second truncate during a rebuild clears only that table and keeps the rebuilt one", async () => {
	const { source } = await liveTwoTables();
	const candidate = source.beginReplacement([MESSAGES]);
	const ledger = source.beginPage(candidate, ["r1"])!;
	await source.applyGroup(candidate, ledger, "r1", [entry({ ts: "50", _id: "m9", doc: { body: "rebuilt" } })]);
	assert.equal(source.truncate(candidate, [LIKES]), true);
	assert.deepEqual(source.stateEntries(candidate), [["chat\u0000messages\u0000m9", [{ body: "rebuilt" }]]]);
	// A replayed truncate of the same table is harmless.
	assert.equal(source.truncate(candidate, [LIKES]), true);
	assert.deepEqual(source.stateEntries(candidate), [["chat\u0000messages\u0000m9", [{ body: "rebuilt" }]]]);
});

test("a second beginReplacement fences the old candidate and re-clones from live, which stays published", async () => {
	const { source } = await liveTwoTables();
	const first = source.beginReplacement([MESSAGES]);
	const ledger = source.beginPage(first, ["r1"])!;
	await source.applyGroup(first, ledger, "r1", [entry({ ts: "50", _id: "m9", doc: { body: "partial" } })]);

	const second = source.beginReplacement([MESSAGES]);
	assert.notEqual(second, first);
	const late = await source.applyGroup(first, ledger, "r1", [entry({ ts: "51", _id: "m8", doc: { body: "late" } })]);
	assert.equal(late.status, "late-generation-dropped");
	assert.deepEqual(source.stateEntries(second), [[KEY_L1, [{ body: "like" }]]], "cloned from live, not from the discarded candidate");
	assert.deepEqual(source.currentSnapshot.get(KEY_M1), [{ body: "hi" }]);
});

test("promoting a replacement publishes the clone plus rebuilt rows in one call and fences the old live generation", async () => {
	const { source, live } = await liveTwoTables();
	const candidate = source.beginReplacement([MESSAGES]);
	const ledger = source.beginPage(candidate, ["r1"])!;
	await source.applyGroup(candidate, ledger, "r1", [entry({ ts: "50", _id: "m9", doc: { body: "rebuilt" } })]);
	const { batches, publish } = recorder();
	assert.equal(await source.promoteWith(candidate, publish), true);
	assert.equal(batches.length, 1);
	assert.deepEqual(new Map(batches[0] as [string, Doc[]][]), new Map([
		[KEY_L1, [{ body: "like" }]],
		["chat\u0000messages\u0000m9", [{ body: "rebuilt" }]],
	]));
	assert.equal(source.currentSnapshot.has(KEY_M1), false, "the truncated table's old rows are gone");
	assert.equal(source.isLive(candidate), true);
	assert.equal(source.liveGeneration, candidate);
	assert.equal(source.candidateGeneration, undefined);
	assert.equal(source.beginPage(live, ["x"]), undefined, "the old live generation is fenced");
});

test("beginReplacement with nothing live throws; truncate on the live generation points to beginReplacement", async () => {
	const cold = new RevisionDeltaSource<Doc>();
	assert.throws(() => cold.beginReplacement([MESSAGES]), /live/);
	const { source, live } = await liveTwoTables();
	assert.throws(() => source.truncate(live, [MESSAGES]), /beginReplacement/);
});

test("a cold generation can truncate its own staged rows", async () => {
	const source = new RevisionDeltaSource<Doc>();
	const gen = source.beginGeneration();
	const ledger = source.beginPage(gen, ["g10"])!;
	await source.applyGroup(gen, ledger, "g10", [entry({ ts: "10" })]);
	assert.equal(source.truncate(gen, [MESSAGES]), true);
	assert.deepEqual(source.stateEntries(gen), []);
	// Truncation forgets the watermark too, so the re-synced row applies.
	const again = source.beginPage(gen, ["g10b"])!;
	const result = await source.applyGroup(gen, again, "g10b", [entry({ ts: "10" })]);
	assert.equal(result.status === "applied" && result.replayIgnored, 0);
});

test("timestamps must be decimal digit strings or bigint; empty, padded, hex, signed, and fractional strings are rejected", () => {
	for (const bad of ["", " 1", "1 ", "0x1", "-1", "+1", "1.5", "1e3"]) {
		assert.throws(() => compareTs(bad, "1"), /invalid revision timestamp/, `compareTs(${JSON.stringify(bad)}, "1") must throw`);
		assert.throws(() => compareTs("1", bad), /invalid revision timestamp/, `compareTs("1", ${JSON.stringify(bad)}) must throw`);
	}
	assert.equal(compareTs("007", 7n), 0, "leading zeros are still a decimal integer");
	const applier = new RevisionDeltaApplier<Doc>();
	assert.throws(() => applier.apply(entry({ ts: "" })), /invalid revision timestamp/);
	assert.throws(() => applier.apply(entry({ ts: "0x10" })), /invalid revision timestamp/);
});

test("live CDC: overlapping applyGroup calls are serialized, so a held-open older publish cannot regress a newer commit", async () => {
	const { source, gen } = liveSource();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const published: string[] = [];

	const first = source.applyGroup(gen, source.beginPage(gen, ["g20"])!, "g20", [entry({ ts: "20", doc: { body: "v20" } })], async (changes) => {
		published.push("v20");
		void changes;
		await gate;
	});
	const second = source.applyGroup(gen, source.beginPage(gen, ["g30"])!, "g30", [entry({ ts: "30", doc: { body: "v30" } })], async () => {
		published.push("v30");
	});
	await Promise.resolve();
	assert.deepEqual(published, ["v20"], "the second group waits for the first to settle");

	release();
	assert.equal((await first).status, "applied");
	assert.equal((await second).status, "applied");
	assert.deepEqual(published, ["v20", "v30"]);
	assert.deepEqual(source.currentSnapshot.get(KEY_M1), [{ body: "v30" }], "the newer group wins");

	const replay = await source.applyGroup(gen, source.beginPage(gen, ["g30"])!, "g30", [entry({ ts: "30", doc: { body: "v30" } })], async () => {
		published.push("replay");
	});
	assert.equal(replay.status, "applied");
	assert.equal(replay.status === "applied" ? replay.replayIgnored : -1, 1, "the committed ts is retained, so a replay is ignored");
	assert.deepEqual(published, ["v20", "v30"], "an ignored replay publishes nothing");
});

test("live CDC: a rejected publish does not block the group queued behind it", async () => {
	const { source, gen } = liveSource();
	const failing = source.applyGroup(gen, source.beginPage(gen, ["g20"])!, "g20", [entry({ ts: "20" })], async () => {
		throw new Error("skip rejected the update");
	});
	const { batches, publish } = recorder();
	const next = source.applyGroup(gen, source.beginPage(gen, ["g30"])!, "g30", [entry({ ts: "30", doc: { body: "v30" } })], publish);
	await assert.rejects(failing, /skip rejected/);
	assert.equal((await next).status, "applied");
	assert.equal(batches.length, 1);
});

test("promoteWith rejects an incomplete page ledger before publishing anything", async () => {
	const source = new RevisionDeltaSource<Doc>();
	const gen = source.beginGeneration();
	const ledger = source.beginPage(gen, ["g10", "g11"])!;
	await source.applyGroup(gen, ledger, "g10", [entry({ ts: "10" })]);
	const { batches, publish } = recorder();
	await assert.rejects(source.promoteWith(gen, publish), /incomplete/);
	assert.equal(batches.length, 0, "nothing reached Skip");
	assert.equal(source.isLive(gen), false);
});

test("a generation superseded while its publish is in flight is dropped and counted, for applyGroup and promoteWith", async () => {
	// applyGroup on the live generation, superseded by a replacement during publish.
	{
		const { source, gen } = liveSource();
		const before = source.lateEventDropCount;
		const result = await source.applyGroup(gen, source.beginPage(gen, ["g20"])!, "g20", [entry({ ts: "20", doc: { body: "late" } })], async () => {
			source.beginReplacement([MESSAGES]);
		});
		assert.equal(result.status, "late-generation-dropped");
		assert.equal(source.lateEventDropCount, before + 1);
		assert.deepEqual(source.currentSnapshot.get(KEY_M1), [{ body: "hi" }], "the superseded group never reaches the live snapshot");
	}
	// promoteWith on a cold build, superseded by a fresh generation during publish.
	{
		const source = new RevisionDeltaSource<Doc>();
		const gen = source.beginGeneration();
		await source.applyGroup(gen, source.beginPage(gen, ["g10"])!, "g10", [entry({ ts: "10" })]);
		const before = source.lateEventDropCount;
		const promoted = await source.promoteWith(gen, async () => {
			source.beginGeneration();
		});
		assert.equal(promoted, false);
		assert.equal(source.lateEventDropCount, before + 1);
		assert.equal(source.isLive(gen), false);
	}
});
