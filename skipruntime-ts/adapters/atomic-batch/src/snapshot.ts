/**
 * `SnapshotBatch` helpers (P2, P3): write one complete `SnapshotBatch` as
 * one Skip update, with no bridge-computed row diffing.
 */

import type { Entry, Json } from "@skipruntime/core";
import { assertNoDuplicateKeys } from "./keys.js";

/**
 * The minimal shape of the Skip callback external-source helpers publish
 * through: `ExternalService.subscribe`'s `callbacks.update`, or any
 * consumer-supplied object with the same signature. P3 requires that a
 * whole external consistency group reach Skip through exactly one call to
 * this method.
 */
export type Writer = {
  update: (entries: Entry<Json, Json>[], isInit: boolean) => Promise<void>;
};

/** One `SnapshotBatch` entry: a query ID or page-region ID and its complete current result rows. */
export type SnapshotEntry = Entry<string, Json>;

/**
 * Builds a `SnapshotBatch`'s entries from `(key, rows)` pairs, rejecting a
 * key used twice. This is the keyed builder P2 and U2 specify for query-ID
 * (1a) and page-region-ID (1b) keys; it performs no row diffing — each
 * value is the key's complete current result array, verbatim.
 */
export function buildSnapshotEntries(
  pairs: readonly (readonly [string, readonly Json[]])[],
): SnapshotEntry[] {
  assertNoDuplicateKeys(pairs);
  // Intentional shallow copy: the array is fresh per key, but the row
  // objects themselves are shared by reference with the caller (verbatim,
  // no diffing — callers must not mutate rows after publishing).
  return pairs.map(([key, rows]) => [key, [...rows]] as SnapshotEntry);
}

/**
 * Applies a `SnapshotBatch` as exactly one `writer.update(entries, isInit)`
 * call (P3). `isInit: true` is permitted only when `liveKeys` names every
 * key that is currently live; any live key missing from `entries` throws,
 * because a partial `isInit: true` reads as a mass delete. The check is
 * intentionally a subset test, not exact equality: extra entry keys beyond
 * `liveKeys` are allowed through untouched.
 */
export async function applySnapshotBatch(
  writer: Writer,
  entries: readonly SnapshotEntry[],
  options: { isInit: false } | { isInit: true; liveKeys: readonly string[] },
): Promise<void> {
  assertNoDuplicateKeys(entries);
  if (options.isInit) {
    const present = new Set(entries.map(([key]) => key));
    const missing = options.liveKeys.filter((key) => !present.has(key));
    if (missing.length > 0) {
      throw new Error(
        `applySnapshotBatch: partial isInit is not allowed; missing live key(s): ${missing.join(", ")}`,
      );
    }
  }
  await writer.update([...entries] as Entry<Json, Json>[], options.isInit);
}
