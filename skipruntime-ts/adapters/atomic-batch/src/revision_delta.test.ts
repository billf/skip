import assert from "node:assert/strict";
import { test } from "node:test";
import { RevisionDeltaApplier, RevisionDeltaSource, compareTs, type RevisionDeltaEntry } from "./revision_delta.js";

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
