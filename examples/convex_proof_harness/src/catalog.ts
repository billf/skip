/**
 * Q11's metric catalog: one TypeScript constant naming every counter/timer
 * the recorder may write, transcribed from the metric-profile and
 * spike-comparison research (see docs/plans/2026-09-14-skip-shared-
 * prerequisites-plan.md, U7, KTD6, for the governing references).
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U7,
 * KTD6.
 *
 * This is the language authority Q11 requires: no consumer defines its own
 * metric names, and the recorder (recorder.ts) rejects anything not listed
 * here. U12's JSON Schemas are hand-maintained separately from this
 * record (there is no codegen step); schema_validate.test.ts pins the
 * drift-relevant expectations instead.
 */

export type Direction = "1a" | "1b" | "1c" | "D2";

export type MetricRequirement = "required" | "optional" | "not-applicable";

export type MetricKind = "counter" | "timer";

export type MetricCatalogEntry = {
	readonly name: string;
	readonly kind: MetricKind;
	readonly unit: string;
	readonly description: string;
	/** Per direction, whether the recorder must, may, or must not see this metric. */
	readonly profile: Readonly<Record<Direction, MetricRequirement>>;
};

/**
 * The core profile table (research-core-metric-profile.md's "Core profile
 * table"). 1a is correctness-only: everything but `mismatch` is
 * not-applicable for it, so its recorder run populates only Q1-Q3 (the
 * gates, not metrics) plus this one counter.
 */
export const CATALOG: readonly MetricCatalogEntry[] = [
	{
		name: "sourceRowsBytes",
		kind: "counter",
		// Compound-unit convention (the only one in this catalog): "a|b"
		// names the two direction-specific encodings sharing this slot
		// (1b's rows vs 1c/D2's bytes); `representation` disambiguates.
		unit: "rows|bytes",
		description:
			"Delivered rows/bytes. 1b's paginated rows and 1c's emitted revisions occupy this " +
			"same canonical slot but are not equivalent efficiency units; samples must set " +
			"`representation` so they are never compared to each other directly.",
		profile: { "1a": "not-applicable", "1b": "required", "1c": "required", D2: "required" },
	},
	{
		name: "atomicBatches",
		kind: "counter",
		unit: "batches",
		description: "Atomic multi-key write batches applied at the source (P3).",
		profile: {
			"1a": "not-applicable",
			"1b": "required",
			"1c": "required",
			D2: "required",
		},
	},
	{
		name: "changedKeys",
		kind: "counter",
		unit: "keys",
		description: "Skip keys reconciled: added + changed + removed.",
		profile: { "1a": "not-applicable", "1b": "required", "1c": "required", D2: "required" },
	},
	{
		name: "dependentWork",
		kind: "counter",
		unit: "nodes",
		description: "Dependent (mapped/joined) nodes updated in response to changed keys.",
		profile: { "1a": "not-applicable", "1b": "required", "1c": "required", D2: "required" },
	},
	{
		name: "reducerWork",
		kind: "counter",
		unit: "ops",
		description: "Reducer add/remove operations (e.g. LikeCount).",
		profile: { "1a": "not-applicable", "1b": "required", "1c": "required", D2: "required" },
	},
	{
		name: "staleDuration",
		kind: "timer",
		unit: "ms",
		description: "Duration the comparator's view was stale before catching up.",
		profile: { "1a": "not-applicable", "1b": "optional", "1c": "required", D2: "required" },
	},
	{
		name: "mismatch",
		kind: "counter",
		unit: "count",
		description:
			"Q3 canonical-equality mismatches against the native oracle. The only metric " +
			"every direction, including correctness-only 1a, always reports.",
		profile: { "1a": "required", "1b": "required", "1c": "required", D2: "required" },
	},
	{
		name: "fallback",
		kind: "counter",
		unit: "count",
		description:
			"Fallback-to-monolithic-path events, by reason. 1c reports reconnect+stale " +
			"duration instead (see staleDuration); only D2 requires this.",
		profile: { "1a": "not-applicable", "1b": "not-applicable", "1c": "not-applicable", D2: "required" },
	},
] as const;

const BY_NAME = new Map(CATALOG.map((entry) => [entry.name, entry]));

export function lookupMetric(name: string): MetricCatalogEntry | undefined {
	return BY_NAME.get(name);
}

export function requirementFor(name: string, direction: Direction): MetricRequirement {
	const entry = BY_NAME.get(name);
	if (entry === undefined) {
		throw new Error(`unknown metric name "${name}" (not in Q11's catalog)`);
	}
	return entry.profile[direction];
}

/** Metric names required for `direction`, per the core profile table. */
export function requiredMetricsFor(direction: Direction): readonly string[] {
	return CATALOG.filter((entry) => entry.profile[direction] === "required").map((entry) => entry.name);
}

/**
 * Metric names whose catalog entry names a same-slot direction-tagged
 * alias (the name-collision map): samples for these metrics must carry a
 * `representation` tag distinguishing e.g. 1b's snapshot rows from 1c's
 * emitted revisions.
 */
export const DIRECTION_TAGGED_METRICS: ReadonlySet<string> = new Set(["sourceRowsBytes"]);
