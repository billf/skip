import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessError } from "./readiness.js";
import { NoTornObserver, extractWatchedValue } from "./observer.js";

// V6's groupProbe: pre {active: true, likeCount: 1}, post {active: false, likeCount: 2}.
const GROUP = {
	resource: "groupProbe",
	pre: { active: true, likeCount: 1 },
	post: { active: false, likeCount: 2 },
};
const SERVED = ["groupProbe", "roomFeed"];

test("computes the membership-first and likes-first half-torn states", () => {
	const observer = new NoTornObserver(GROUP, SERVED);
	assert.deepEqual(observer.expectedHalfTornStates, [
		{ active: false, likeCount: 1 },
		{ active: true, likeCount: 2 },
	]);
});

test("an atomic sequence passes", () => {
	const observer = new NoTornObserver(GROUP, SERVED);
	observer.observe("1", { active: true, likeCount: 1 }); // pre
	observer.observe("2", { active: false, likeCount: 2 }); // post, no intermediate
	assert.equal(observer.passed, true);
	assert.deepEqual(observer.tornEvents, []);
});

test("a membership-first two-step sequence reports the torn event's watermark", () => {
	const observer = new NoTornObserver(GROUP, SERVED);
	observer.observe("1", { active: true, likeCount: 1 });
	observer.observe("2", { active: false, likeCount: 1 }); // membership flips first: torn
	observer.observe("3", { active: false, likeCount: 2 });
	assert.equal(observer.passed, false);
	assert.equal(observer.tornEvents.length, 1);
	assert.equal(observer.tornEvents[0]!.watermark, "2");
	assert.deepEqual(observer.tornEvents[0]!.state, { active: false, likeCount: 1 });
});

test("a likes-first two-step sequence reports the torn event's watermark", () => {
	const observer = new NoTornObserver(GROUP, SERVED);
	observer.observe("1", { active: true, likeCount: 1 });
	observer.observe("2", { active: true, likeCount: 2 }); // likes bump first: torn
	observer.observe("3", { active: false, likeCount: 2 });
	assert.equal(observer.passed, false);
	assert.equal(observer.tornEvents[0]!.watermark, "2");
});

test("a group definition on the feed alone for V6 is rejected as a harness error", () => {
	// V6's canonical feed alone cannot tell the two write orders apart: the
	// membership-first intermediate already equals the final `Out()`
	// (the row is simply absent from the feed's roomFeed projection either
	// way once the membership half of the group has applied, regardless of
	// which half applies second), so a group watching only the feed names
	// an identical pre/post from the feed's point of view.
	assert.throws(
		() =>
			new NoTornObserver(
				{
					resource: "roomFeed",
					pre: { present: false },
					post: { present: false },
				},
				SERVED,
			),
		HarnessError,
	);
});

test("a consumer service that does not serve groupProbe is rejected as a harness error", () => {
	assert.throws(() => new NoTornObserver(GROUP, ["roomFeed"]), HarnessError);
});

test("pre equal to post is rejected as a harness error", () => {
	assert.throws(
		() => new NoTornObserver({ resource: "groupProbe", pre: { a: 1 }, post: { a: 1 } }, SERVED),
		HarnessError,
	);
});

test("a single-field partial equal to pre or post is rejected as a harness error", () => {
	// Only one field ever changes: its "half-torn" state (post's value with
	// nothing else different) *is* the post-state itself.
	assert.throws(
		() => new NoTornObserver({ resource: "groupProbe", pre: { a: 1 }, post: { a: 2 } }, SERVED),
		HarnessError,
	);
});

test("a group with an added key is rejected as a harness error", () => {
	// F1a: the added key is a changed field (union of pre/post keys), so this
	// group has exactly one changed field, not two -- and its single partial
	// *is* the post-state. Previously Object.keys(pre) missed `b` entirely,
	// yielding zero partials and silently accepting the group.
	assert.throws(
		() => new NoTornObserver({ resource: "groupProbe", pre: { a: 1 }, post: { a: 1, b: 2 } }, SERVED),
		HarnessError,
	);
});

test("a group with three changed fields is rejected as a harness error", () => {
	// F1b: three changed fields have multi-field (2-of-3) partials this
	// observer does not enumerate, so the two-field contract refuses them.
	assert.throws(
		() =>
			new NoTornObserver(
				{ resource: "groupProbe", pre: { a: 1, b: 1, c: 1 }, post: { a: 2, b: 2, c: 2 } },
				SERVED,
			),
		HarnessError,
	);
});

test("unrelated interleaved updates do not false-positive; heartbeats are ignored", () => {
	const observer = new NoTornObserver(GROUP, SERVED);
	observer.observe("1", { active: true, likeCount: 1 });
	observer.observe("1.5", undefined); // heartbeat / unrelated key
	observer.observe("2", { active: false, likeCount: 2 });
	assert.equal(observer.passed, true);
});

test("extractWatchedValue resolves a matching key's latest value and ignores others", () => {
	const entries: [unknown, unknown[]][] = [
		["other-key", [{ x: 1 }]],
		["watched-key", [{ active: true, likeCount: 1 }]],
	];
	assert.deepEqual(extractWatchedValue(entries, "watched-key"), { active: true, likeCount: 1 });
	assert.equal(extractWatchedValue(entries, "missing-key"), undefined);
	assert.equal(extractWatchedValue([["watched-key", []]], "watched-key"), undefined);
});
