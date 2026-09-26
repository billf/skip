/**
 * Q2's label-mapped parity function: pure code over two per-table row
 * sets, ported bit-for-bit from convex-tutorial's
 * `convex/proofVehicle/fixture.ts` `computeParity` (that copy is the one
 * convex-test actually runs against; this copy is what a consumer without
 * access to the tutorial's modules -- Q has no convex-test reader, see
 * KTD -- uses to pre-check a deployment/convex-test pair before admitting
 * convex-test as Q2's native reader). A failed parity check is a harness
 * error, never a Skip mismatch.
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U8,
 * Q2, KTD5.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "./readiness.js";

export type TableParity = { readonly count: number; readonly contentHash: string };

/** The hash algorithm ID recorded in `corpus/v1.parity.json` / `testdata/v1.parity.json`. */
export const PARITY_HASH_ALGORITHM = "sha256-json-sorted-keys-v1";

const ID_LIKE_FIELDS = new Set(["_id", "room", "user", "sender", "message"]);

/**
 * Every `_id` and foreign-key `Id` field is replaced by its corpus label,
 * `_creationTime` is dropped (real wall-clock time under convex-test,
 * import-assigned time on a deployment -- neither reproducible across two
 * independent loads), rows are sorted by their mapped `_id` for
 * order-independence, and the result is JSON with sorted object keys,
 * hashed with SHA-256.
 */
export function computeParity(
	rows: readonly Record<string, unknown>[],
	labelByRawId: ReadonlyMap<string, string>,
): TableParity {
	const mapValue = (key: string, value: unknown): unknown => {
		if (ID_LIKE_FIELDS.has(key) && typeof value === "string") {
			return labelByRawId.get(value) ?? value;
		}
		return value;
	};
	const mapped = rows.map((row) => {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(row).sort()) {
			if (key === "_creationTime") continue;
			out[key] = mapValue(key, row[key]);
		}
		return out;
	});
	mapped.sort((a, b) => {
		const ai = String(a["_id"]);
		const bi = String(b["_id"]);
		return ai < bi ? -1 : ai > bi ? 1 : 0;
	});
	const canonical = JSON.stringify(mapped);
	const contentHash = createHash("sha256").update(canonical).digest("hex");
	return { count: rows.length, contentHash };
}

/** Throws a harness error, never returns a mismatch, when two table parities disagree. */
export function assertParityMatch(label: string, a: TableParity, b: TableParity): void {
	if (a.count !== b.count || a.contentHash !== b.contentHash) {
		throw new HarnessError(
			`parity check failed for "${label}": {count: ${a.count}, contentHash: ${a.contentHash}} vs ` +
				`{count: ${b.count}, contentHash: ${b.contentHash}}`,
		);
	}
}

export type VendoredParity = {
	readonly fixtureSetVersion: string;
	readonly hashAlgorithm: string;
	readonly vectors: Record<string, Record<string, TableParity>>;
};

const TESTDATA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata", "v1.parity.json");

export const EXPECTED_FIXTURE_SET_VERSION = "1.0.0";

/** Loads the vendored golden parity hashes, failing on algorithm or fixture-set-version mismatch. */
export function loadVendoredParity(fromPath: string = TESTDATA_PATH): VendoredParity {
	let text: string;
	try {
		text = readFileSync(fromPath, "utf8");
	} catch (err) {
		throw new HarnessError(
			`cannot read vendored parity file at "${fromPath}": ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new HarnessError(
			`vendored parity file at "${fromPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new HarnessError(`vendored parity file at "${fromPath}" has an unrecognized shape: expected an object`);
	}
	const record = parsed as Record<string, unknown>;
	if (record["hashAlgorithm"] !== PARITY_HASH_ALGORITHM) {
		throw new HarnessError(
			`vendored parity file's hash algorithm "${String(record["hashAlgorithm"])}" does not match ` +
				`this build's "${PARITY_HASH_ALGORITHM}"`,
		);
	}
	if (record["fixtureSetVersion"] !== EXPECTED_FIXTURE_SET_VERSION) {
		throw new HarnessError(
			`vendored parity file's fixture set version "${String(record["fixtureSetVersion"])}" does not match ` +
				`this build's "${EXPECTED_FIXTURE_SET_VERSION}"`,
		);
	}
	assertVectorsShape(record["vectors"], fromPath);
	return parsed as VendoredParity;
}

/** Validates the vectors table before first use so a bad golden fails here as a HarnessError, not later as a TypeError. */
function assertVectorsShape(vectors: unknown, fromPath: string): void {
	const bad = (detail: string): HarnessError =>
		new HarnessError(`vendored parity file at "${fromPath}" has an unrecognized vectors shape: ${detail}`);
	if (typeof vectors !== "object" || vectors === null || Array.isArray(vectors)) {
		throw bad("expected a { vector: { table: { count, contentHash } } } object");
	}
	for (const [vectorName, tables] of Object.entries(vectors as Record<string, unknown>)) {
		if (typeof tables !== "object" || tables === null || Array.isArray(tables)) {
			throw bad(`vector "${vectorName}" is not an object`);
		}
		for (const [tableName, parity] of Object.entries(tables as Record<string, unknown>)) {
			if (typeof parity !== "object" || parity === null || Array.isArray(parity)) {
				throw bad(`vector "${vectorName}" table "${tableName}" is not an object`);
			}
			const entry = parity as Record<string, unknown>;
			if (typeof entry["count"] !== "number" || typeof entry["contentHash"] !== "string") {
				throw bad(
					`vector "${vectorName}" table "${tableName}" needs a numeric count and a string contentHash`,
				);
			}
		}
	}
}
