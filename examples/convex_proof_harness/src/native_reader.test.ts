import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeReader, admitNativeSample } from "./native_reader.js";

test("a native result read before the target revision is labeled incomparable", () => {
	const result = admitNativeSample({ version: 5, value: "x" }, 10, undefined);
	assert.equal(result.kind, "incomparable");
});

test("one read at or past the target with no later write issued is admitted", () => {
	const result = admitNativeSample({ version: 10, value: "x" }, 10, undefined);
	assert.deepEqual(result, { kind: "admitted", version: 10, value: "x" });
});

test("a mutation that commits before the native read but resolves after it makes the sample incomparable", () => {
	// Target mutation committed at version 10; another mutation committed at
	// 11 (after the target) before this native read (at version 12) returned.
	const result = admitNativeSample({ version: 12, value: "x" }, 10, 11);
	assert.equal(result.kind, "incomparable");
});

test("a mutation committed at or before the target version does not affect admission", () => {
	const result = admitNativeSample({ version: 12, value: "x" }, 10, 10);
	assert.equal(result.kind, "admitted");
});

test("NativeReader wraps a caller-supplied one-shot reader with the admission rule", async () => {
	const reader = new NativeReader({ read: () => Promise.resolve({ version: 3, value: { feed: [] } }) });
	const result = await reader.sampleAtOrPast(3, () => undefined);
	assert.deepEqual(result, { kind: "admitted", version: 3, value: { feed: [] } });

	const stale = await reader.sampleAtOrPast(4, () => undefined);
	assert.equal(stale.kind, "incomparable");
});

test("NativeReader observes a mutation committed while the read is in flight", async () => {
	// The getter is invoked after read() resolves, so a mutation that
	// commits during the pending read forces incomparable. A value bound at
	// call time could not see this commit.
	let committed: number | undefined = undefined;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reader = new NativeReader({ read: () => gate.then(() => ({ version: 12, value: "x" })) });
	const pending = reader.sampleAtOrPast(10, () => committed);
	committed = 11; // commits after sampleAtOrPast was called, before the read returns
	release();
	const raced = await pending;
	assert.equal(raced.kind, "incomparable");
});

test("NativeReader still admits when the latest commit observed post-read is at or before the target", async () => {
	const reader = new NativeReader({ read: () => Promise.resolve({ version: 12, value: "x" }) });
	const atTarget = await reader.sampleAtOrPast(10, () => 10);
	assert.equal(atTarget.kind, "admitted");
	const none = await reader.sampleAtOrPast(10, () => undefined);
	assert.equal(none.kind, "admitted");
});
