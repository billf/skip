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
  chained setup/teardown (`research-postgres-reference.md`); delivery
  serialization + generation fencing from
  `adapters/convex/src/index.ts:244-363`.
- Each revision group = one `callbacks.update(updates,false)` call onto
  the merged tagged domain (see P envelope doc); the retained
  join+reducer graph (`TasksByProject`/`AddTaskTotals` shape in
  `examples/convex_reactive/skip/service.ts:51-87`) applies add/remove
   incrementally. Steady-state delivery/input `O(K)` + derived `O(K+F)`
  vs `O(N)` snapshot — the only spike allowed `O()` notation in its
  scaling-notation requirement (1c R16, local-only).
- Keying: `(component,table,_id)` → Skip string key; in-value `ts`
  watermark (not session tick); tombstones `[key,[]]` with GC +
  generation-fencing/pending-ledger per
  `data-sync-push-ktd-generation-fenced-ingestion` /
  `data-sync-push-ktd-single-collection-tagged-keys` /
  `data-sync-push-ktd-scoped-replay-watermarks`. Decimal-string
  timestamps (>2^53) pass through as strings (cf. postgres passing
  timestamp strings straight through in `adapters/postgres/index.ts:16-18`
  to avoid heap clobbering).
- Cursor-after-apply checkpointing with revision-watermark idempotency;
  duplicate/gap/retention/compaction behavior per the push-stream seam
   note. `data-sync-push-u-implement-push-service` /
  `data-sync-push-u-retained-graph-comparison-harness` depend on shared
  P/Q (envelope + comparator) from plan `1159`, with hand-build fallback
  if P/Q has not landed.

## Vehicle and harness pointers

- Skip graph: `examples/chatroom/reactive_service/chatroom.service.ts`
  plus `examples/convex_reactive/skip/service.ts` one-atomic-call
  workaround; 1c adds `adapters/convex/src/data_sync_push.ts(.test.ts)`
  and `examples/convex_data_sync_push/{shared/model,skip/service+server,
  bench/compare}` per the plan's units (U1-U3/U5 backend/tutorial out of
  Skip scope; Skip owns U4/U6 above).
- Convex side: `convex-tutorial convex/chat.ts,schema.ts,chat.test.ts`
  (`messages.user:v.id(users)`, `Unknown` fallback for dangling refs,
  cf. `data-sync-push-u-deterministic-tutorial-mutations`).
- Results: `bench/compare.ts` JSONL
  (`data-sync-push-ktd-diagnostic-jsonl-schema`, same units as 1b),
  `RESULTS.md` with N/K/F curves, scan-amplification, and freshness chain
  `commit→readable→delivered→applied→published`.

Probe: seeded revision-group replay (duplicate + gap injection) against
the retained graph; assert idempotent apply and `O(K)` delivery sizes
independent of N.

## Sources

- `convex-backend/docs/plans/IDENTIFIER-MAP.md`
  (`data-sync-push-atomic-revision-group-apply`,
  `data-sync-push-ktd-generation-fenced-ingestion`,
  `data-sync-push-ktd-single-collection-tagged-keys`,
  `data-sync-push-ktd-scoped-replay-watermarks`,
  `data-sync-push-ktd-diagnostic-jsonl-schema`)
- Plan `2026-09-10-1854-feat-skip-data-sync-push-source-spike-plan.md`
- `skipruntime-ts/helpers/src/external.ts:61-121`
- `skipruntime-ts/adapters/postgres/src/index.ts:42-59,247-292`
- `skipruntime-ts/adapters/convex/src/index.ts:244-386`
- `examples/convex_reactive/skip/service.ts:51-87,151-163`
- `research-shared-PQ-skip-shape.md` (this directory)
