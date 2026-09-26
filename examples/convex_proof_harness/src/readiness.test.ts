import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckpointEmitter } from "./checkpoint.js";
import { QuiescedWriteCoordinator, ReadinessDetector } from "./readiness.js";

test("readiness never fires before the required version, even with a heartbeat or empty update", () => {
	const d = new ReadinessDetector("quiesced", 100);
	d.observeGate2({ kind: "heartbeat" });
	d.observeGate2({ kind: "empty-update" });
	d.observeGate2({ kind: "checkpoint", version: 50 });
	assert.equal(d.gate2, false);
	d.observeGate2({ kind: "checkpoint", version: 100 });
	assert.equal(d.gate2, true);
	assert.equal(d.publishedVersion, 100);
});

test("a no-output-change step still settles on its checkpoint event", () => {
	// V3 delta 3's delete of U(c) changes no published row, but the source
	// still calls checkpoint(version) for that transition (KTD4).
	const d = new ReadinessDetector("quiesced", 42);
	d.observeGate2({ kind: "checkpoint", version: 42 });
	assert.equal(d.gate2, true);
});

test("a consumer built only on the exported checkpoint emitter reaches gate 2 on a no-change step", () => {
	const emitter = new CheckpointEmitter();
	const d = new ReadinessDetector("quiesced", 7);
	emitter.addSink((frame) => {
		const match = /data: (.+)\n\n/.exec(frame);
		assert.ok(match);
		const { version } = JSON.parse(match[1]!) as { version: number };
		d.observeGate2({ kind: "checkpoint", version });
	});
	assert.equal(d.gate2, false);
	emitter.checkpoint(7);
	assert.equal(d.gate2, true);
});

test("a source on a separate session reaches gate 1 through the marker sequence", () => {
	const d = new ReadinessDetector("quiesced", 1000);
	// The ack from `fixture:marker` is sequence 5; the source-session
	// transition observes sequence 4 first (not yet), then 5.
	d.observeGate1({ kind: "source-marker", ackSeq: 5, observedSeq: 4, ts: 10 });
	assert.equal(d.gate1, false);
	d.observeGate1({ kind: "source-marker", ackSeq: 5, observedSeq: 5, ts: 20 });
	assert.equal(d.gate1, true);
});

test("gate 1 via marker sequence for a base-state marker and for V3 delta 3", () => {
	const base = new ReadinessDetector("quiesced", 1);
	base.observeGate1({ kind: "source-marker", ackSeq: 1, observedSeq: 1, ts: 1 });
	assert.equal(base.gate1, true);

	const delta3 = new ReadinessDetector("quiesced", 1);
	delta3.observeGate1({ kind: "source-marker", ackSeq: 3, observedSeq: 3, ts: 30 });
	assert.equal(delta3.gate1, true);
});

test("gate 1 also fires from a same-session source version at or past the required version", () => {
	const d = new ReadinessDetector("quiesced", 100);
	d.observeGate1({ kind: "source-version", ts: 99 });
	assert.equal(d.gate1, false);
	d.observeGate1({ kind: "source-version", ts: 100 });
	assert.equal(d.gate1, true);
});

test("revision-tagged mode ignores an earlier revision", () => {
	const d = new ReadinessDetector("revision-tagged", 5);
	d.observeGate2({ kind: "checkpoint", version: 5 });
	assert.equal(d.gate2, true);
	assert.equal(d.publishedVersion, 5);
	// A later-arriving but logically earlier revision must not regress gate 2.
	d.observeGate2({ kind: "checkpoint", version: 3 });
	assert.equal(d.publishedVersion, 5);
});

test("revision-tagged mode does not latch gate 2 on a later revision without the exact required one", () => {
	const d = new ReadinessDetector("revision-tagged", 5);
	d.observeGate2({ kind: "checkpoint", version: 6 });
	assert.equal(d.gate2, false);
	assert.equal(d.publishedVersion, undefined);
});

test("quiesced coordinator holds writes until gates 1, 2, and 3 all report; Q1 itself never reads the oracle", () => {
	const d = new ReadinessDetector("quiesced", 10);
	const coordinator = new QuiescedWriteCoordinator(d);
	assert.equal(coordinator.writesHeld, true);

	d.observeGate1({ kind: "source-version", ts: 10 });
	assert.equal(coordinator.writesHeld, true, "gate 2 still missing");

	d.observeGate2({ kind: "checkpoint", version: 10 });
	assert.equal(coordinator.writesHeld, true, "gate 3 (Q2) still missing");

	coordinator.reportGate3FromQ2();
	assert.equal(coordinator.writesHeld, false);

	// ReadinessDetector's own public surface has no oracle-reading method.
	assert.equal("readOracle" in d, false);
});
