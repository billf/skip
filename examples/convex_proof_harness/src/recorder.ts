/**
 * Q5's recorder: owns checkpoint gate four (the freshness disposition) and
 * writes one JSONL record per checkpoint, validating every metric name and
 * every direction's required/optional/not-applicable profile against
 * KTD6's catalog (catalog.ts). docs/plans/2026-09-11-1159-feat-skip-shared-prerequisites-plan.md,
 * U7, Q5, Q10, Q11.
 */

import { CATALOG, DIRECTION_TAGGED_METRICS, type Direction } from "./catalog.js";
import { HarnessError } from "./readiness.js";

const BY_NAME = new Map(CATALOG.map((entry) => [entry.name, entry]));

/**
 * Expected `representation` tag per direction for direction-tagged slots:
 * 1b reads snapshot rows, while 1c and D2 read emitted revisions. These
 * encodings occupy the same canonical slot but are not equivalent
 * efficiency units, so a sample tagged with the wrong direction's
 * representation is a harness error, not a valid record.
 */
const EXPECTED_REPRESENTATION: Readonly<Record<Exclude<Direction, "1a">, "snapshot-rows" | "revisions">> = {
	"1b": "snapshot-rows",
	"1c": "revisions",
	D2: "revisions",
};

/**
 * Gate four: recorded, never inferred from silence. `current` is a runtime
 * publication state; `stale-with-reason`/`fallback-with-reason` each carry
 * why (Q12).
 */
export type FreshnessDisposition =
	| { readonly kind: "current" }
	| { readonly kind: "stale-with-reason"; readonly reason: string }
	| { readonly kind: "fallback-with-reason"; readonly reason: string };

/**
 * `representation` distinguishes same-slot, non-equivalent direction
 * encodings (1b's snapshot rows vs 1c's emitted revisions) per the
 * name-collision map; it is required on `sourceRowsBytes` samples (and
 * must match the recording direction) and rejected on every other metric.
 */
export type MetricSample = {
	readonly name: string;
	readonly value: number;
	readonly representation?: "snapshot-rows" | "revisions";
};

export type CheckpointRecord = {
	readonly event: "checkpoint";
	readonly direction: Direction;
	readonly version: number;
	readonly freshness: FreshnessDisposition;
	readonly metrics: readonly MetricSample[];
};

/**
 * Records one checkpoint's metrics as one JSONL line. Every recorded
 * metric must be in KTD6's catalog and applicable to `direction`; every
 * metric the catalog requires for `direction` must be present. An unknown
 * name or a missing required metric is a harness error (never a silently
 * incomplete report).
 */
export class Recorder {
	private readonly lines: string[] = [];

	constructor(private readonly sink: (line: string) => void = (line) => this.lines.push(line)) {}

	record(
		direction: Direction,
		version: number,
		freshness: FreshnessDisposition,
		metrics: readonly MetricSample[],
	): void {
		if (!Number.isFinite(version)) {
			throw new HarnessError(`non-finite checkpoint version ${String(version)} for direction "${direction}"`);
		}
		const seen = new Set<string>();
		for (const sample of metrics) {
			if (seen.has(sample.name)) {
				throw new HarnessError(`duplicate metric "${sample.name}" in one record() call for direction "${direction}"`);
			}
			const entry = BY_NAME.get(sample.name);
			if (entry === undefined) {
				throw new HarnessError(`unknown metric name "${sample.name}" (not in Q11's catalog)`);
			}
			if (entry.profile[direction] === "not-applicable") {
				throw new HarnessError(`metric "${sample.name}" is not-applicable for direction "${direction}"`);
			}
			if (!Number.isFinite(sample.value)) {
				throw new HarnessError(
					`non-finite value ${String(sample.value)} for metric "${sample.name}" (direction "${direction}"): ` +
						`JSON.stringify would silently persist it as null`,
				);
			}
			if (DIRECTION_TAGGED_METRICS.has(sample.name)) {
				if (sample.representation === undefined) {
					throw new HarnessError(
						`metric "${sample.name}" occupies a direction-tagged slot and requires a ` +
							`"representation" tag (snapshot-rows vs revisions) on every sample`,
					);
				}
				const expected = direction === "1a" ? undefined : EXPECTED_REPRESENTATION[direction];
				if (expected !== undefined && sample.representation !== expected) {
					throw new HarnessError(
						`metric "${sample.name}" for direction "${direction}" carries representation ` +
							`"${sample.representation}" but requires "${expected}"`,
					);
				}
			} else if (sample.representation !== undefined) {
				throw new HarnessError(
					`metric "${sample.name}" is not direction-tagged but carries a stray ` +
						`representation "${sample.representation}" (direction "${direction}")`,
				);
			}
			seen.add(sample.name);
		}
		for (const entry of CATALOG) {
			if (entry.profile[direction] === "required" && !seen.has(entry.name)) {
				throw new HarnessError(`missing required metric "${entry.name}" for direction "${direction}"`);
			}
		}
		const record: CheckpointRecord = {
			event: "checkpoint",
			direction,
			version,
			freshness,
			metrics: [...metrics],
		};
		this.sink(JSON.stringify(record));
	}

	/** The JSONL report accumulated so far (only meaningful with the default in-memory sink). */
	get jsonl(): string {
		return this.lines.length === 0 ? "" : this.lines.join("\n") + "\n";
	}
}
