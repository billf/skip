import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckpointEmitter, formatCheckpointFrame } from "./checkpoint.js";

test("formatCheckpointFrame writes an SSE checkpoint event carrying the version", () => {
	const frame = formatCheckpointFrame(42);
	assert.match(frame, /^event: checkpoint\n/);
	assert.match(frame, /data: \{"version":42\}\n\n$/);
});

test("checkpoint fans out to every open sink and none once removed", () => {
	const emitter = new CheckpointEmitter();
	const receivedA: string[] = [];
	const receivedB: string[] = [];
	const sinkA = (frame: string): void => {
		receivedA.push(frame);
	};
	const sinkB = (frame: string): void => {
		receivedB.push(frame);
	};
	emitter.addSink(sinkA);
	emitter.addSink(sinkB);
	assert.equal(emitter.sinkCount, 2);

	emitter.checkpoint(1);
	assert.equal(receivedA.length, 1);
	assert.equal(receivedB.length, 1);

	emitter.removeSink(sinkA);
	emitter.checkpoint(2);
	assert.equal(receivedA.length, 1);
	assert.equal(receivedB.length, 2);
});

test("one throwing sink does not starve the remaining sinks and is surfaced via onSinkError", () => {
	const reported: unknown[] = [];
	const emitter = new CheckpointEmitter((_sink, error) => {
		reported.push(error);
	});
	const receivedA: string[] = [];
	const receivedC: string[] = [];
	const boom = new Error("dead SSE connection");
	emitter.addSink((frame) => {
		receivedA.push(frame);
	});
	emitter.addSink((_frame) => {
		throw boom;
	});
	emitter.addSink((frame) => {
		receivedC.push(frame);
	});

	emitter.checkpoint(9);
	assert.equal(receivedA.length, 1);
	assert.equal(receivedC.length, 1);
	assert.equal(reported.length, 1);
	assert.equal(reported[0], boom);
});
