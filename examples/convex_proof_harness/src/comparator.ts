/**
 * The normalized deep-equal comparator (Q3): compares an expected
 * canonical feed against an actual one, positionally (it trusts neither
 * side to be re-sorted here -- a swapped tie must surface as a mismatch,
 * not be silently absorbed by re-ordering), and reports structured
 * mismatches rather than a bare boolean.
 *
 * Strictness policy: known contract fields are compared exactly;
 * surplus top-level fields on actual rows are ignored (known-fields-only
 * comparison). A stricter exact-shape policy was considered and deferred.
 */

import type { FeedRow } from "./corpus.js";
import { deepEqual } from "./deep_equal.js";

export type Mismatch = {
	vector: string;
	key: string | null;
	field: string;
	expected: unknown;
	actual: unknown;
};

function normalizeSender(sender: unknown): { _id: string; name: string } | null | undefined {
	if (sender === null) return null;
	if (
		typeof sender === "object" &&
		typeof (sender as { _id?: unknown })._id === "string" &&
		typeof (sender as { name?: unknown }).name === "string"
	) {
		return {
			_id: (sender as { _id: string })._id,
			name: (sender as { name: string }).name,
		};
	}
	// Anything else (e.g. the string "Unknown") is left as-is so it fails
	// the deep-equal check against the expected null/object shape.
	return sender as unknown as { _id: string; name: string } | null | undefined;
}

function fieldMismatches(
	vector: string,
	key: string,
	expected: FeedRow,
	actual: Record<string, unknown>,
): Mismatch[] {
	const mismatches: Mismatch[] = [];
	const checkField = (field: string, expectedValue: unknown, actualValue: unknown) => {
		if (!deepEqual(expectedValue, actualValue)) {
			mismatches.push({ vector, key, field, expected: expectedValue, actual: actualValue });
		}
	};
	checkField("_id", expected._id, actual["_id"]);
	checkField("_creationTime", expected._creationTime, actual["_creationTime"]);
	checkField("room", expected.room, actual["room"]);
	checkField("body", expected.body, actual["body"]);
	checkField("likeCount", expected.likeCount, actual["likeCount"]);
	checkField("sender", expected.sender, normalizeSender(actual["sender"]));
	return mismatches;
}

/**
 * Compares `expected` (the corpus's resolved canonical feed) against
 * `actual` (a reader's result), returning every structured mismatch. An
 * empty array means the feeds match.
 */
export function compareFeeds(
	vector: string,
	expected: readonly FeedRow[],
	actual: readonly unknown[],
): Mismatch[] {
	const mismatches: Mismatch[] = [];
	const max = Math.max(expected.length, actual.length);
	for (let i = 0; i < max; i++) {
		const expectedRow = expected[i];
		const actualRow = actual[i] as Record<string, unknown> | undefined;
		if (expectedRow === undefined) {
			mismatches.push({
				vector,
				key: typeof actualRow?.["_id"] === "string" ? (actualRow["_id"] as string) : `index:${i}`,
				field: "presence",
				expected: undefined,
				actual: actualRow,
			});
			continue;
		}
		if (actualRow === undefined || actualRow === null) {
			mismatches.push({
				vector,
				key: expectedRow._id,
				field: "presence",
				expected: expectedRow,
				actual: actualRow,
			});
			continue;
		}
		mismatches.push(...fieldMismatches(vector, expectedRow._id, expectedRow, actualRow));
	}
	return mismatches;
}
