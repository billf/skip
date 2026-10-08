/**
 * Q6's revision-delta fault extension: the CDC-path injectors, proven here
 * against a scripted mock and against real triggers in 1c's U6. Each
 * reuses U10's `FaultHarness`/assertions (`injector.ts`) rather than a
 * second detection/recovery/count implementation.
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U14,
 * Q6 (extension), Q7.
 */

import type { FaultInjector, FaultTrigger } from "./injector.js";

/**
 * Data Sync's soft limits (PROVISIONAL — claimed from research, not yet
 * verified against the Data Sync source; verify before live wiring in
 * 1c's U6): past any of these, a transaction is oversized.
 */
export const DATA_SYNC_SOFT_LIMITS = {
  maxEntries: 16384,
  maxBytes: 64 * 1024 * 1024,
  maxRows: 32768,
} as const;

export function exceedsDataSyncSoftLimits(txn: {
  entries: number;
  bytes: number;
  rows: number;
}): boolean {
  return (
    txn.entries > DATA_SYNC_SOFT_LIMITS.maxEntries ||
    txn.bytes > DATA_SYNC_SOFT_LIMITS.maxBytes ||
    txn.rows > DATA_SYNC_SOFT_LIMITS.maxRows
  );
}

/** Cursor expired: the retained cursor is too old to resume from; forces a resnapshot, keeping the last good result frozen. */
export function cursorExpiredFault(trigger: FaultTrigger): FaultInjector {
  return {
    name: "cursor-expired",
    counterName: "cursorExpired",
    expectedState: "frozen",
    trigger,
  };
}

/** Cursor invalid: the retained cursor no longer names a valid position; forces a resnapshot, last good stays frozen. */
export function cursorInvalidFault(trigger: FaultTrigger): FaultInjector {
  return {
    name: "cursor-invalid",
    counterName: "cursorInvalid",
    expectedState: "frozen",
    trigger,
  };
}

/** Cursor ahead: the retained cursor is ahead of the source's own log; forces a resnapshot, last good stays frozen. */
export function cursorAheadFault(trigger: FaultTrigger): FaultInjector {
  return {
    name: "cursor-ahead",
    counterName: "cursorAhead",
    expectedState: "frozen",
    trigger,
  };
}

/** Table replacement, returning to snapshotting: the last good result stays frozen (Replacing-keeps-last-good) until the new candidate promotes. */
export function tableReplacementFault(trigger: FaultTrigger): FaultInjector {
  return {
    name: "table-replacement-return-to-snapshotting",
    counterName: "tableReplacement",
    expectedState: "frozen",
    trigger,
  };
}

/** An oversized transaction past Data Sync's soft limits: handled like any other forced resnapshot, last good stays frozen. */
export function oversizedTransactionFault(
  trigger: FaultTrigger,
): FaultInjector {
  return {
    name: "oversized-transaction",
    counterName: "oversizedTransaction",
    expectedState: "frozen",
    trigger,
  };
}

/**
 * A Skip-process restart mid-CDC. With retained state (a cursor and its
 * generation survived the restart) it resumes and stays frozen at the
 * last good result; with no retained state it starts cold
 * (`not-yet-loaded`), never publishing a blank result as if it were
 * current.
 */
export function restartMidCdcFault(
  trigger: FaultTrigger,
  hasRetainedState: boolean,
): FaultInjector {
  return {
    name: "restart-mid-cdc",
    counterName: "restartMidCdc",
    expectedState: hasRetainedState ? "frozen" : "not-yet-loaded",
    trigger,
  };
}
