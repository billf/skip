import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParseError, SseReader, assertLoopbackUrl, classifyFrame } from "./sse_reader.js";

test("events split across chunks and multiple events per chunk parse correctly", () => {
	const updates: [string, unknown][] = [];
	const reader = new SseReader("http://127.0.0.1:9999/v1/streams/abc", {
		onUpdate: (watermark, values) => updates.push([watermark, values]),
	});

	// One event split across two chunks.
	reader.push('event: update\nid: 1\ndata: [["k1",[');
	reader.push('"v1"]]]\n\n');
	// Two events delivered in a single chunk.
	reader.push('event: update\nid: 2\ndata: [["k2",["v2"]]]\n\nevent: update\nid: 3\ndata: [["k3",["v3"]]]\n\n');

	assert.deepEqual(updates, [
		["1", [["k1", ["v1"]]]],
		["2", [["k2", ["v2"]]]],
		["3", [["k3", ["v3"]]]],
	]);
});

test("heartbeats are ignored while an id:-bearing empty update is delivered", () => {
	let heartbeats = 0;
	const updates: [string, unknown][] = [];
	const reader = new SseReader("http://127.0.0.1:9999/v1/streams/abc", {
		onHeartbeat: () => {
			heartbeats += 1;
		},
		onUpdate: (watermark, values) => updates.push([watermark, values]),
	});

	reader.push("event: update\ndata:[]\n\n");
	assert.equal(heartbeats, 1);
	assert.equal(updates.length, 0);

	reader.push('event: update\nid: 5\ndata: []\n\n');
	assert.equal(heartbeats, 1);
	assert.deepEqual(updates, [["5", []]]);
});

test("checkpoint events are delivered with their version", () => {
	const versions: number[] = [];
	const reader = new SseReader("http://127.0.0.1:9999/v1/streams/abc", {
		onCheckpoint: (v) => versions.push(v),
	});
	reader.push('event: checkpoint\ndata: {"version":42}\n\n');
	assert.deepEqual(versions, [42]);
});

test("a 0.0.0.0 or remote URL is refused", () => {
	assert.throws(() => assertLoopbackUrl("http://0.0.0.0:8080/v1/streams/abc"));
	assert.throws(() => assertLoopbackUrl("https://example.com/v1/streams/abc"));
	assertLoopbackUrl("http://127.0.0.1:8080/v1/streams/abc");
	assertLoopbackUrl("http://localhost:8080/v1/streams/abc");
});

test("an unknown init/update variant fails closed while other unknown event names are counted", () => {
	assert.throws(
		() => classifyFrame({ event: "init", id: "1", data: "not json" }),
		SseParseError,
	);
	assert.throws(
		() => classifyFrame({ event: "update", id: "1", data: '{"not":"an array"}' }),
		SseParseError,
	);

	const unknownNames: string[] = [];
	const reader = new SseReader("http://127.0.0.1:1/v1/streams/x", {
		onUnknownEvent: (name) => unknownNames.push(name),
	});
	reader.push("event: some-future-event\ndata: whatever\n\n");
	assert.deepEqual(unknownNames, ["some-future-event"]);
	assert.equal(reader.unknownEventCount, 1);
});

test("a transcript with a malformed data: payload or an unknown init/update variant fails with a parse error naming the event", () => {
	const reader = new SseReader("http://127.0.0.1:1/v1/streams/x", {});
	assert.throws(() => reader.push('event: init\nid: 1\ndata: {"oops"\n\n'), /"init"/);

	const reader2 = new SseReader("http://127.0.0.1:1/v1/streams/x", {});
	assert.throws(() => reader2.push("event: init\ndata: []\n\n"), /"init"/);
});

test("init events are delivered distinctly from update events", () => {
	const inits: [string, unknown][] = [];
	const reader = new SseReader("http://127.0.0.1:1/v1/streams/x", {
		onInit: (watermark, values) => inits.push([watermark, values]),
	});
	reader.push('event: init\nid: 0\ndata: [["k",["v"]]]\n\n');
	assert.deepEqual(inits, [["0", [["k", ["v"]]]]]);
});

test("an id-less frame with non-empty data fails closed instead of being swallowed as a heartbeat", () => {
	// A real update that lost its id: line (or any malformed id-less
	// payload) must throw, not vanish into the heartbeat path.
	assert.throws(() => classifyFrame({ event: "update", data: '[["k",["v"]]]' }), SseParseError);
	assert.throws(() => classifyFrame({ event: undefined, data: '[["k",["v"]]]' }), SseParseError);
	assert.throws(() => classifyFrame({ event: "update", data: "not json" }), SseParseError);
	assert.throws(() => classifyFrame({ event: "update", data: '{"not":"an array"}' }), SseParseError);

	// Genuine heartbeats still classify: data:[] with no id, or no data at all.
	assert.deepEqual(classifyFrame({ event: "update", data: "[]" }), { kind: "heartbeat" });
	assert.deepEqual(classifyFrame({ event: undefined, data: "[]" }), { kind: "heartbeat" });
	assert.deepEqual(classifyFrame({ event: "update", data: "" }), { kind: "heartbeat" });

	// End to end: the reader surfaces the throw and records no heartbeat.
	let heartbeats = 0;
	const reader = new SseReader("http://127.0.0.1:1/v1/streams/x", {
		onHeartbeat: () => {
			heartbeats += 1;
		},
	});
	assert.throws(() => reader.push('event: update\ndata: [["k",["v"]]]\n\n'), SseParseError);
	assert.equal(heartbeats, 0);
});

test("CRLF and lone-CR framing parses instead of stalling", () => {
	const updates: [string, unknown][] = [];
	let heartbeats = 0;
	const reader = new SseReader("http://127.0.0.1:1/v1/streams/x", {
		onUpdate: (watermark, values) => updates.push([watermark, values]),
		onHeartbeat: () => {
			heartbeats += 1;
		},
	});
	reader.push("event: update\r\nid: 1\r\ndata: []\r\n\r\n");
	reader.push("event: update\rid: 2\rdata: []\r\r");
	reader.push("event: update\r\ndata:[]\r\n\r\n");
	assert.deepEqual(updates, [
		["1", []],
		["2", []],
	]);
	assert.equal(heartbeats, 1);
});

test("repeated data: lines join with a newline per the SSE spec", () => {
	const versions: number[] = [];
	const reader = new SseReader("http://127.0.0.1:1/v1/streams/x", {
		onCheckpoint: (v) => versions.push(v),
	});
	// A pretty-printed JSON payload split across two data: lines.
	reader.push('event: checkpoint\ndata: {"version":\ndata: 42}\n\n');
	assert.deepEqual(versions, [42]);
});

test("flush throws on a non-whitespace trailing remainder and accepts a clean end", () => {
	const clean = new SseReader("http://127.0.0.1:1/v1/streams/x", {});
	clean.push('event: update\nid: 1\ndata: []\n\n');
	clean.flush(); // no throw

	const blank = new SseReader("http://127.0.0.1:1/v1/streams/x", {});
	blank.push("   \n");
	blank.flush(); // whitespace-only remainder is benign

	const truncated = new SseReader("http://127.0.0.1:1/v1/streams/x", {});
	truncated.push("event: update\nid: 1");
	assert.throws(() => truncated.flush(), SseParseError);
});
