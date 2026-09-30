---
title: 1c push-source Skip contract
type: research-note
status: active
direction: direction-1c
date: 2026-09-13
---

# 1c push-source Skip contract

Skip-side shape for plan `2026-09-10-1854` (modest backend change:
authed Data-Sync SSE stream; drain-then-wait on native readable
timestamp; revision groups applied atomically to a retained join+reducer
graph). Pairs with convex-backend `research-data-sync-source.md`,
`research-push-stream-seam.md`, `research-delta-seam.md`,
`research-backend-change-hook.md` (the last two retained for orientation;
seam choice settled per direction by the Data Sync note).

## Rule: custom push `ExternalService`, one atomic batch per revision group

- Implement `ExternalService`, not `PolledExternalService`
  (`helpers/src/external.ts:61-121` is the negative example: polling,
  no channels). Reference lifecycle: postgres `chainInstanceOp` +
  chained setup/teardown; delivery
  serialization + generation fencing from
  `adapters/convex/src/index.ts:244-363`.
- Each revision group = one `callbacks.update(updates,false)` call onto
  the merged tagged domain (see P envelope doc); the retained
  join+reducer graph (`TasksByProject`/`AddTaskTotals` shape in
  `examples/convex_reactive/skip/service.ts:51-87`) applies add/remove
   incrementally. Steady-state delivery/input `O(K)` + derived `O(K+F)`
  vs `O(N)` snapshot per `data-sync-push-scaling-by-n-k-f` — the only
  spike allowed `O()` notation in its scaling rule.
- Keying: `(component,table,_id)` → Skip string key; in-value `ts`
  watermark (not session tick); tombstones `[key,[]]` with GC +
  generation-fencing/pending-ledger per
  `data-sync-push-ktd-generation-fenced-ingestion` /
  `data-sync-push-ktd-single-collection-tagged-keys` /
  `data-sync-push-ktd-scoped-replay-watermarks`. Decimal-string
  timestamps (>2^53) pass through as strings (cf. postgres passing
  timestamp strings straight through in
  `skipruntime-ts/adapters/postgres/src/index.ts:16-18` to avoid heap
  clobbering).
- Cursor-after-apply checkpointing with revision-watermark idempotency;
  duplicate/gap/retention/compaction behavior per the push-stream seam
   note. Publication states per
  `research-publication-state-semantics.md`: snapshotting (no candidate)
  → stale / replacing-keeps-last-good → current after final group +
  cursor; versioned `error` freezes the watermark (cold-or-resume per
  retryable flag). Cursor-specific metrics per
  `research-core-metric-profile.md` (resets, replayed/ignored, wake-ups
  by cause, suppressed refreshes). `data-sync-push-u-implement-push-service` /
  `data-sync-push-u-retained-graph-comparison-harness` depend on shared
  P/Q (envelope + comparator) from plan `1159`, with hand-build fallback
  if P/Q has not landed.

## Vehicle and harness pointers

- Skip graph: `examples/chatroom/reactive_service/src/chatroom.service.ts`
  plus `examples/convex_reactive/skip/service.ts` one-atomic-call
  workaround; 1c adds `adapters/convex/src/data_sync_push.ts(.test.ts)`
  and `examples/convex_data_sync_push/{shared/model,skip/service+server,
  bench/compare}` per the plan's units (backend selection/cursor
  per `data-sync-push-fixed-selection-cursor`, emission per
  `data-sync-push-progress-driven-page-emission`, backpressure per
  `data-sync-push-bounded-stream-backpressure` are out of Skip scope;
  Skip owns `data-sync-push-u-implement-push-service` /
  `data-sync-push-u-retained-graph-comparison-harness` above).
- Convex side: tutorial `convex/schema.ts` + `convex/chat.ts` gain the
  shared rooms/memberships/likes fixture fields, deterministic mutations
  (sender rename, membership activation/deactivation, like add/remove,
  dangling sender, membership+likes multi-table transaction), the bounded
  canonical-result query, and the all-selected-rows baseline
  (cf. `data-sync-push-u-deterministic-tutorial-mutations`). Missing
  senders stay `null` (nullable-sender parity, not `"Unknown"`); missing
  liked users keep their like row in the count.
- Results: `bench/compare.ts` JSONL
  (`data-sync-push-ktd-diagnostic-jsonl-schema`, same units as 1b),
  `RESULTS.md` with N/K/F curves, scan-amplification, freshness chain
  `commit→readable→delivered→applied→published`, counters per
  `data-sync-push-wake-and-work-counters`, timers per
  `data-sync-push-freshness-latency-timers`, staging per
  `data-sync-push-staging-generation-activation`, replacement per
  `data-sync-push-atomic-table-replacement`, recovery per
  `data-sync-push-reconnect-and-cold-recovery` /
  `data-sync-push-terminal-error-freshness-safety`, quiescence per
  `data-sync-push-quiescent-empty-recheck`.

Probe: seeded revision-group replay (duplicate + gap injection) against
the retained graph; assert idempotent apply and `O(K)` delivery sizes
independent of N.

## Sources

- `convex-backend/research/skip-convex-integration/research-publication-state-semantics.md`
  (snapshotting/stale/replacing/current + versioned-error mapping)
- `convex-backend/research/skip-convex-integration/research-core-metric-profile.md`
  (cursor-specific extension)
- `convex-backend/docs/plans/IDENTIFIER-MAP.md`
  (`data-sync-push-atomic-revision-group-apply`,
  `data-sync-push-fixed-selection-cursor`,
  `data-sync-push-progress-driven-page-emission`,
  `data-sync-push-quiescent-empty-recheck`,
  `data-sync-push-bounded-stream-backpressure`,
  `data-sync-push-staging-generation-activation`,
  `data-sync-push-atomic-table-replacement`,
  `data-sync-push-generation-scoped-replay-idempotency`,
  `data-sync-push-reconnect-and-cold-recovery`,
  `data-sync-push-terminal-error-freshness-safety`,
  `data-sync-push-scaling-by-n-k-f`,
  `data-sync-push-wake-and-work-counters`,
  `data-sync-push-freshness-latency-timers`,
  `data-sync-push-ktd-generation-fenced-ingestion`,
  `data-sync-push-ktd-single-collection-tagged-keys`,
  `data-sync-push-ktd-scoped-replay-watermarks`,
  `data-sync-push-ktd-diagnostic-jsonl-schema`)
- Plan `2026-09-10-1854-feat-skip-data-sync-push-source-spike-plan.md`
- `skipruntime-ts/helpers/src/external.ts:61-121`
- `skipruntime-ts/adapters/postgres/src/index.ts:42-59,247-292`
- `skipruntime-ts/adapters/convex/src/index.ts:244-386`
- `examples/convex_reactive/skip/service.ts:51-87,151-163`
