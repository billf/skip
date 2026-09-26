/**
 * Loads and verifies the vendored V1-V6 corpus, and resolves its `Out(...)`
 * rows into comparable feed rows through a caller-supplied label-binding
 * map. docs/plans/2026-09-14-skip-shared-prerequisites-plan.md,
 * U6, KTD5.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CorpusOutRow = {
	id: string;
	creationTime: number;
	room: string;
	body: string;
	sender: { id: string; name: string } | null;
	likeCount: number;
};

export type CorpusDelta = { mutation: string; args: Record<string, unknown>; label?: string };

export type CorpusVector = {
	title: string;
	base: unknown[];
	expectedBase: CorpusOutRow[];
	deltas?: CorpusDelta[];
	expectedAfterDelta?: (CorpusOutRow[] | null)[];
	independentDeltas?: { title: string; mutation: string; args: Record<string, unknown>; expected: CorpusOutRow[] }[];
};

export type Corpus = {
	fixtureSetVersion: string;
	vectors: Record<string, CorpusVector>;
};

const TESTDATA_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"testdata",
	"semantic-vectors-v1.json",
);

/**
 * The corpus's canonical form: parsed JSON, re-serialized with every
 * object's keys sorted (recursively; array order is preserved) so
 * formatting-only edits (whitespace, key order) never change the hash.
 */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = canonicalize((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

export function computeSemanticHash(corpus: Corpus): string {
	const canonical = JSON.stringify(canonicalize(corpus));
	return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Recorded once, from the vendored copy at `testdata/semantic-vectors-v1.json`.
 * A vendored copy that reformats (whitespace, key order) still matches;
 * one that changes meaning (rows, expected output, IDs) does not.
 *
 * Refresh procedure: re-vendor the tutorial copy, recompute with
 * `computeSemanticHash(loadUncachedCopy())`, and record the new digest here.
 */
export const EXPECTED_SEMANTIC_HASH =
	"4d9e54062fa267633277bf84faa78908e33cf5c1f5de4ca24ddda60cf59fb284";

export class CorpusSemanticHashError extends Error {
	constructor(actual: string, expected: string) {
		super(
			`Vendored corpus semantic hash mismatch: expected ${expected}, got ${actual}. ` +
				"The tutorial's copy (convex-tutorial: convex/proofVehicle/corpus/v1.json) is canonical.",
		);
		this.name = "CorpusSemanticHashError";
	}
}

let cached: Corpus | undefined;

/**
 * Loads the vendored corpus, throwing `CorpusSemanticHashError` on semantic drift.
 *
 * Shared-reference contract: every call after the first returns the same
 * object reference. Callers must not mutate the result in place (clone
 * before mutating); a mutation would silently corrupt all later readers.
 */
export function loadCorpus(): Corpus {
	if (cached !== undefined) return cached;
	const corpus = JSON.parse(readFileSync(TESTDATA_PATH, "utf8")) as Corpus;
	const actual = computeSemanticHash(corpus);
	if (actual !== EXPECTED_SEMANTIC_HASH) {
		throw new CorpusSemanticHashError(actual, EXPECTED_SEMANTIC_HASH);
	}
	cached = corpus;
	return corpus;
}

/** The shared proof-vehicle contract's canonical feed row shape. */
export type FeedRow = {
	_id: string;
	_creationTime: number;
	room: string;
	body: string;
	sender: { _id: string; name: string } | null;
	likeCount: number;
};

/** Resolves a corpus `Out(...)` row's symbolic labels to real IDs via `idByLabel`. */
export function resolveExpectedRow(
	row: CorpusOutRow,
	idByLabel: ReadonlyMap<string, string>,
): FeedRow {
	const id = (label: string): string => {
		const resolved = idByLabel.get(label);
		if (resolved === undefined) throw new Error(`resolveExpectedRow: unbound label "${label}"`);
		return resolved;
	};
	return {
		_id: id(row.id),
		_creationTime: row.creationTime,
		room: id(row.room),
		body: row.body,
		sender: row.sender === null ? null : { _id: id(row.sender.id), name: row.sender.name },
		likeCount: row.likeCount,
	};
}

/** Resolves a full expected feed array (e.g. a vector's `expectedBase`) via `idByLabel`. */
export function resolveExpectedFeed(
	rows: readonly CorpusOutRow[],
	idByLabel: ReadonlyMap<string, string>,
): FeedRow[] {
	return rows.map((row) => resolveExpectedRow(row, idByLabel));
}
