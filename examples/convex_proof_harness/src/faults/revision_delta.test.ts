import assert from "node:assert/strict";
import { test } from "node:test";
import { FaultHarness } from "./injector.js";
import {
	DATA_SYNC_SOFT_LIMITS,
	cursorAheadFault,
	cursorExpiredFault,
	cursorInvalidFault,
	exceedsDataSyncSoftLimits,
	oversizedTransactionFault,
	restartMidCdcFault,
	tableReplacementFault,
} from "./revision_delta.js";

function mockTrigger(): { trigger: () => void; calls: number[] } {
	const calls: number[] = [];
	return { trigger: () => void calls.push(1), calls };
}

// Independently stated expected states per factory (u14-2): hardcoded
// literals, NOT read back from injector.expectedState, so a wrong constant
// on any factory fails this test instead of passing tautologically.
const EXPECTED_STATES = {
	"cursor-expired": "frozen",
	"cursor-invalid": "frozen",
	"cursor-ahead": "frozen",
	"table-replacement": "frozen",
	"oversized-transaction": "frozen",
	"restart-mid-cdc": "frozen",
} as const;

test("each injector against the scripted mock reaches its expected publication state and counter", async () => {
	const harness = new FaultHarness();
	const cases = [
		{ injector: cursorExpiredFault(mockTrigger().trigger), name: "cursor-expired" },
		{ injector: cursorInvalidFault(mockTrigger().trigger), name: "cursor-invalid" },
		{ injector: cursorAheadFault(mockTrigger().trigger), name: "cursor-ahead" },
		{ injector: tableReplacementFault(mockTrigger().trigger), name: "table-replacement" },
		{ injector: oversizedTransactionFault(mockTrigger().trigger), name: "oversized-transaction" },
		{ injector: restartMidCdcFault(mockTrigger().trigger, true), name: "restart-mid-cdc" },
	] as const;
	for (const { injector, name } of cases) {
		const expected = EXPECTED_STATES[name];
		assert.equal(injector.expectedState, expected, `${name} factory states ${expected}`);
		const calls: number[] = [];
		const probed = { ...injector, trigger: () => void calls.push(1) };
		await harness.run(probed, () => expected);
		assert.equal(calls.length, 1, `${name} trigger was actually invoked`);
		harness.assertCount(probed, 1);
	}

	const counterNames = new Set(cases.map((c) => c.injector.counterName));
	assert.equal(counterNames.size, cases.length, "each injector has its own counter");
});

test("a restart with no retained state starts cold", async () => {
	const harness = new FaultHarness();
	const cold = restartMidCdcFault(mockTrigger().trigger, false);
	assert.equal(cold.expectedState, "not-yet-loaded");
	await harness.run(cold, () => "not-yet-loaded");

	const warm = restartMidCdcFault(mockTrigger().trigger, true);
	assert.equal(warm.expectedState, "frozen");
	await harness.run(warm, () => "frozen");
});

test("a restart mid-CDC never publishes current, retained state or not", async () => {
	const harness = new FaultHarness();
	const cold = restartMidCdcFault(mockTrigger().trigger, false);
	await assert.rejects(harness.run(cold, () => "current"));
	const warm = restartMidCdcFault(mockTrigger().trigger, true);
	await assert.rejects(harness.run(warm, () => "current"));
});

test("exceedsDataSyncSoftLimits flags any single limit crossed", () => {
	assert.equal(exceedsDataSyncSoftLimits({ entries: 1, bytes: 1, rows: 1 }), false);
	assert.equal(
		exceedsDataSyncSoftLimits({ entries: DATA_SYNC_SOFT_LIMITS.maxEntries + 1, bytes: 1, rows: 1 }),
		true,
	);
	assert.equal(exceedsDataSyncSoftLimits({ entries: 1, bytes: DATA_SYNC_SOFT_LIMITS.maxBytes + 1, rows: 1 }), true);
	assert.equal(exceedsDataSyncSoftLimits({ entries: 1, bytes: 1, rows: DATA_SYNC_SOFT_LIMITS.maxRows + 1 }), true);
	assert.equal(
		exceedsDataSyncSoftLimits({
			entries: DATA_SYNC_SOFT_LIMITS.maxEntries,
			bytes: DATA_SYNC_SOFT_LIMITS.maxBytes,
			rows: DATA_SYNC_SOFT_LIMITS.maxRows,
		}),
		false,
		"exactly at the limit does not exceed it",
	);
});
