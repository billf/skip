---
title: 1b paginated regions Skip shape
type: research-note
status: active
direction: direction-1b
date: 2026-09-13
---

# 1b paginated regions Skip shape

Skip-side shape for plan `2026-09-10-1843` (index-ordered Convex reactive
pages as separate Skip input regions, no backend changes, no raw
`/api/sync`). Pairs with convex-backend `research-1b-page-topology.md`.

## Rule: preserve page identity; republish only changed pages

- Concatenating pages into one result (the `use_paginated_query`
  keep-old-until-replacements-load pattern) is invalid per
  `paginated-reactive-source-stable-page-snapshot-region`: each live page
  keeps its own snapshot region without concatenating the loaded window.
  The mapped merge rule is `paginated-reactive-source-disjoint-page-merge`:
  any page change republishes the whole concatenation through
  reconciliation if concatenated.
  Instead each page keeps its own input region (own collection or key
  prefix) per `paginated-reactive-source-indexed-reactive-pagination`;
  when a page changes, only that page republishes
  (`paginated-reactive-source-page-local-incremental-update`); unchanged
  pages stay out of Skip's reconciliation entirely.
- Skip merges/orders/reduces across regions downstream. Reducer needs an
  inverse `remove` per `paginated-reactive-source-loaded-window-reducer`
  (precedent `AddTaskTotals:80-86` in
  `examples/convex_reactive/skip/service.ts`) so page moves are
  add+remove, not rescan.
- Disjointness + ordering: assert disjoint IDs across pages; tie-break
  `[_id]` (or `[_creationTime,_id]` per the shared envelope) for
  deterministic order. Page splits (1→2) need
  `paginated-reactive-source-atomic-page-split`: keep the old page active
  until both replacements are complete, then exchange in one atomic Skip
  update (merged-domain trick or scoped multi-region update — the latter
  does not exist, see atomic-write gap doc). A `SplitRequired` result is
  `paginated-reactive-source-incomplete-split-result` and is never
  published. Without atomic swap a moving row briefly appears twice or
  not at all.

## Metrics from Skip

- Steady-state source→Skip work follows affected-page size, not total
  loaded N, per `paginated-reactive-source-scaling-page-size-work` and
  `paginated-reactive-source-no-full-republish-scaling`. Report: total
  loaded rows N, target page size / affected-page counts K, positions
  touched. No join fan-out F in this vehicle (no cross-table join at the
  input boundary).
- Costs to quantify alongside the win per
  `paginated-reactive-source-page-work-instrumentation`: bootstrap (N
  pages × init), subscription state (N page subscriptions), retention,
  and the `dir.keys()` + `native_eq` compare per republished page.
  Stale windows rebuild per
  `paginated-reactive-source-stale-window-rebuild`.
- Baseline per `paginated-reactive-source-settled-monolithic-correctness`
  and `paginated-reactive-source-monolithic-query-comparison`:
  independent monolithic indexed Convex query ("monolithic" =
  unpaginated vs paginated contrast), plus Skip over the monolithic
  snapshot to isolate the page-region effect. Harness scope per
  `paginated-reactive-source-transition-grouped-client-scope` (no raw 1a
  client) and flows `paginated-reactive-source-steady-state-page-update` /
  `paginated-reactive-source-atomic-page-split` /
  `paginated-reactive-source-comparison-run`.

Probe: two-page harness over a changing index range; mutate one row in
page 0, assert only page 0's region republishes and reducer output stays
correct; split a page and assert the atomic-swap invariant.

## Sources

- `convex-backend/docs/plans/IDENTIFIER-MAP.md`
  (`paginated-reactive-source-indexed-reactive-pagination`,
  `paginated-reactive-source-stable-page-snapshot-region`,
  `paginated-reactive-source-atomic-page-split`,
  `paginated-reactive-source-incomplete-split-result`,
  `paginated-reactive-source-loaded-window-reducer`,
  `paginated-reactive-source-page-local-incremental-update`,
  `paginated-reactive-source-settled-monolithic-correctness`,
  `paginated-reactive-source-stale-window-rebuild`,
  `paginated-reactive-source-scaling-page-size-work`,
  `paginated-reactive-source-page-work-instrumentation`,
  `paginated-reactive-source-monolithic-query-comparison`,
  `paginated-reactive-source-no-full-republish-scaling`,
  `paginated-reactive-source-transition-grouped-client-scope`,
  `paginated-reactive-source-steady-state-page-update`,
  `paginated-reactive-source-atomic-page-split`,
  `paginated-reactive-source-comparison-run`,
  `paginated-reactive-source-bounded-prefix-load`,
  `paginated-reactive-source-disjoint-page-merge`,
  `shared-prereqs-p-single-fork-per-atomic-unit`)
- Plan `2026-09-10-1843-feat-skip-paginated-reactive-source-spike-plan.md`
- `examples/convex_reactive/skip/service.ts:51-87` (mapper+reducer shape)
- `skiplang/prelude/src/skstore/EagerDir.sk:1717-1729`
- `skipruntime-ts/skiplang/core/src/Runtime.sk:1038-1065`
- `research-skip-atomic-write-gap.md` (this directory)
