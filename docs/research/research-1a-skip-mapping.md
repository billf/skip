---
title: 1a sync-protocol Skip mapping
type: research-note
status: active
direction: direction-1a
date: 2026-09-13
---

# 1a sync-protocol Skip mapping

Skip-side shape for plan `2026-09-10-1509` (direct WebSocket `/api/sync`
client, no backend changes): each fully-reassembled Transition becomes
one atomic Skip write with no bridge diffing. Pairs with convex-backend
`research-sync-protocol-skip-mapping.md`,
`research-sync-wire-ts-checklist.md`, `research-1a-review-answers.md`.

## Rule: reassemble, then one `isInit:true` write per query

- Transport delivers whole query results (`QueryUpdated.value`); the
  bridge must not diff. Reassemble chunks/`TransitionChunk` per query,
  then write the query's full result with `isInit:true` so
  `writeInCollection` (`Runtime.sk:1038-1065`) reconciles natively and
  `EagerDir.writeEntry` (`EagerDir.sk:1727`) short-circuits unchanged keys
  via `native_eq` — no dirty marking, no reducer work for them.
- One `context.update()` per call = one reactive tick and one subscriber
  notification set. Two queries = two ticks; subscribers observe the
   intermediate (see `research-skip-atomic-write-gap.md`). The
  `sync-protocol-client-atomic-transition-apply` choice is therefore:
  single merged input domain (loses per-query init
  granularity, keeps atomicity) vs scoped batch primitive (does not
  exist) vs per-query ticks + downstream merge (eventual consistency).
- Failure handling: freeze vs `QueryRemoved`-clear per the mapping doc;
  on rejected `callbacks.update`, tear down and re-establish as a fresh
  initial snapshot (convex adapter `resubscribe():274-305`), never a
  partial diff. Reconnect snapshot follows the same path.

## Skip vehicle to reuse

`examples/convex_reactive/skip/service.ts:34-87,151-163`: one `workspace`
external collection → `ProjectsOnly`/`TasksOnly` split →
`TasksByProject.map` → `AddTaskTotals.reduce` (with inverse `remove`) →
`AttachTotals` join. 1a keeps this graph and swaps only the source: raw
`/api/sync` Transition applier in place of `ConvexClient.onUpdate` +
`diffSnapshot`. Cross-table aggregate for the demo is per-project
task counts/effort sums; correctness is an independent Convex reader at
settled checkpoints, never Skip-internal consistency.

## Costs stated up front

- `isInit:true` cost: `dir.keys()` enumeration + per-key `writeEntry`
  compare + full snapshot over FFI per Transition. No re-propagation for
  unchanged keys, but the snapshot still crosses the bridge every time.
- No perf claim in 1a by explicit Key Decision — bounded semantic
  correctness only. Scaling curves belong to 1b/1c/Dir2.

Probe: `FakeConvex`-style harness (`adapters/convex/index.test.ts:18-80`)
feeding full query results with `isInit:true`; assert unchanged keys cause
no reducer work and multi-query delivers show the intermediate unless
merged into one domain.

## Sources

- `convex-backend/docs/plans/IDENTIFIER-MAP.md`
  (`sync-protocol-client-atomic-transition-apply`,
  `sync-protocol-client-cross-query-reducer`,
  `sync-protocol-client-settled-checkpoint-comparator`)
- Plan `2026-09-10-1509-feat-skip-sync-protocol-client-plan.md`
- `skipruntime-ts/skiplang/core/src/Runtime.sk:1038-1065`
- `skiplang/prelude/src/skstore/EagerDir.sk:1717-1729`
- `skipruntime-ts/core/src/index.ts:469-533`
- `skipruntime-ts/adapters/convex/src/index.ts:133-163,274-333`
- `examples/convex_reactive/skip/service.ts:34-164`
