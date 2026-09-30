---
title: 1a sync-protocol Skip mapping
type: research-note
status: active
direction: direction-1a
date: 2026-09-13
---

# 1a sync-protocol Skip mapping

Skip-side shape for plan `2026-09-10-1509` (direct WebSocket `/api/sync`
client, no backend changes): each reassembled query result is written
with `isInit:true`, one tick per query, with no bridge diffing; a whole
Transition is atomic only if its queries share one merged input domain,
and then the write must carry that domain's full snapshot (or use
`isInit:false` deltas with explicit tombstones). Pairs with convex-backend
`research-sync-protocol-skip-mapping.md`,
`research-sync-wire-ts-checklist.md`, `research-1a-review-answers.md`.

## Rule: reassemble, then one `isInit:true` write per query

- Transport delivers whole query results (`QueryUpdated.value`); the
  bridge must not diff, per
  `sync-protocol-client-direct-readonly-sync-client` and
  `sync-protocol-client-snapshot-reconciliation`. Reassemble
  chunks/`TransitionChunk` per query, then write the query's full result
  with `isInit:true` so `writeInCollection` (`Runtime.sk:1042-1069`)
  reconciles natively and `EagerDir.writeEntry` (`EagerDir.sk:1727`)
  short-circuits unchanged keys via `native_eq` — no dirty marking, no
  reducer work for them. Liveness per
  `sync-protocol-client-live-cross-table-aggregate`; per-table inputs per
  `sync-protocol-client-per-table-query-proof-input`.
- One `context.update()` per call = one reactive tick and one subscriber
  notification set. Two queries = two ticks; subscribers observe the
   intermediate (see `research-skip-atomic-write-gap.md`). The
  `sync-protocol-client-atomic-transition-apply` choice is therefore:
  single merged input domain (loses per-query init
  granularity, keeps atomicity) vs scoped batch primitive (does not
  exist) vs per-query ticks + downstream merge (eventual consistency).
- Failure handling per `sync-protocol-client-last-good-failure-state`
  (freeze with stale indicator) vs
  `sync-protocol-client-unsubscribe-removal` (`QueryRemoved`-clear inside
  the atomic update); flows `sync-protocol-client-query-failure-recovery`,
  `sync-protocol-client-live-cross-table-aggregate`,
  `sync-protocol-client-atomic-cross-table-update` /
  `sync-protocol-client-stale-last-good-on-failure`, vehicle
  `sync-protocol-client-chatroom-tutorial-proof`, record
  `sync-protocol-client-bounded-feasibility-record`. Publication states
  per `research-publication-state-semantics.md`: not-yet-loaded (no
  prior good) vs frozen-stale (prior good, known-behind) vs FatalError
  distinct from frozen-stale; failure checkpoints never count as
  settled. On rejected `callbacks.update`, tear down and re-establish
  as a fresh initial snapshot (convex adapter `resubscribe():274-305`),
  never a partial diff. Reconnect snapshot follows the same path.

## Skip vehicle to reuse

`examples/convex_reactive/skip/service.ts:34-87,151-163`: one `workspace`
external collection → `ProjectsOnly`/`TasksOnly` split →
`TasksByProject.map` → `AddTaskTotals.reduce` (with inverse `remove`) →
`AttachTotals` join — the mapper/reducer topology a 1a proof reuses,
repointed at the five-table contract. 1a keeps this graph shape and swaps
only the source: raw `/api/sync` Transition applier in place of
`ConvexClient.onUpdate` + `diffSnapshot`. The demo computes the Shared
proof-vehicle contract's canonical room feed plus per-message `likeCount`
(a membership-change + like-add transaction is the atomicity acceptance);
correctness is the independent native reader implementing that contract
at settled checkpoints, never Skip-internal consistency. The local
projects/tasks `workspace` stays a mechanism demo, not the proof
vehicle.

## Costs stated up front

- `isInit:true` cost: `dir.keys()` enumeration + per-key `writeEntry`
  compare + full snapshot over FFI per Transition. No re-propagation for
  unchanged keys, but the snapshot still crosses the bridge every time.
- No perf claim in 1a by explicit Key Decision — bounded semantic
  correctness only. Scaling curves belong to 1b/1c/Dir2.

Probe: `FakeConvex`-style harness
(`skipruntime-ts/adapters/convex/src/index.test.ts:18-84`)
feeding full query results with `isInit:true`; assert unchanged keys cause
no reducer work and multi-query delivers show the intermediate unless
merged into one domain.

## Sources

- `convex-backend/research/skip-convex-integration/research-publication-state-semantics.md`
  (not-yet-loaded vs frozen-stale vs FatalError mapping)
- `convex-backend/docs/plans/IDENTIFIER-MAP.md`
  (`sync-protocol-client-direct-readonly-sync-client`,
  `sync-protocol-client-snapshot-reconciliation`,
  `sync-protocol-client-atomic-transition-apply`,
  `sync-protocol-client-cross-query-reducer`,
  `sync-protocol-client-settled-checkpoint-comparator`,
  `sync-protocol-client-last-good-failure-state`,
  `sync-protocol-client-unsubscribe-removal`,
  `sync-protocol-client-chatroom-tutorial-proof`,
  `sync-protocol-client-per-table-query-proof-input`,
  `sync-protocol-client-bounded-feasibility-record`,
  `sync-protocol-client-live-cross-table-aggregate`,
  `sync-protocol-client-query-failure-recovery`,
  `sync-protocol-client-atomic-cross-table-update`,
  `sync-protocol-client-stale-last-good-on-failure`)
- Plan `2026-09-10-1509-feat-skip-sync-protocol-client-plan.md`
- `skipruntime-ts/skiplang/core/src/Runtime.sk:1042-1069`
- `skiplang/prelude/src/skstore/EagerDir.sk:1717-1729`
- `skipruntime-ts/core/src/index.ts:469-533`
- `skipruntime-ts/adapters/convex/src/index.ts:133-163,274-333`
- `examples/convex_reactive/skip/service.ts:34-164`
