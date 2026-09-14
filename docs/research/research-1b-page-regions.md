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
  keep-old-until-replacements-load pattern) is invalid for the page-region
  requirement (1b R3, local-only): any page
  change republishes the whole concatenation through reconciliation.
  Instead each page keeps its own input region (own collection or key
  prefix); when a page changes, only that page republishes; unchanged
  pages stay out of Skip's reconciliation entirely.
- Skip merges/orders/reduces across regions downstream. Reducer needs an
  inverse `remove` (precedent `AddTaskTotals:80-86` in
  `examples/convex_reactive/skip/service.ts`) so page moves are
  add+remove, not rescan.
- Disjointness + ordering: assert disjoint IDs across pages; tie-break
  `[_id]` (or `[_creationTime,_id]` per the shared envelope) for
  deterministic order. Page splits (1→2) need an atomic split-swap:
  either the merged-domain trick (one tick) or a scoped multi-region
  atomic update (does not exist — see atomic-write gap doc). Without it a
  moving row briefly appears twice or not at all.

## Metrics from Skip

- Steady-state source→Skip work follows affected-page size, not total
  loaded N. Report: total loaded rows N, target page size / affected-page
  counts K, positions touched. No join fan-out F in this vehicle (no
  cross-table join at the input boundary).
- Costs to quantify alongside the win: bootstrap (N pages × init),
  subscription state (N page subscriptions), retention, and the
  `dir.keys()` + `native_eq` compare per republished page.
- Baseline: independent monolithic indexed Convex query ("monolithic" =
  unpaginated vs paginated contrast), plus Skip over the monolithic
  snapshot to isolate the page-region effect.

Probe: two-page harness over a changing index range; mutate one row in
page 0, assert only page 0's region republishes and reducer output stays
correct; split a page and assert the atomic-swap invariant.

## Sources

- `convex-backend/docs/plans/IDENTIFIER-MAP.md`
  (`paginated-reactive-source-bounded-prefix-load`,
  `paginated-reactive-source-disjoint-page-merge`,
  `shared-prereqs-p-single-fork-per-atomic-unit`)
- Plan `2026-09-10-1843-feat-skip-paginated-reactive-source-spike-plan.md`
- `examples/convex_reactive/skip/service.ts:51-87` (mapper+reducer shape)
- `skiplang/prelude/src/skstore/EagerDir.sk:1717-1729`
- `skipruntime-ts/skiplang/core/src/Runtime.sk:1038-1065`
- `research-skip-atomic-write-gap.md` (this directory)
