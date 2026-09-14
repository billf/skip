---
title: Direction 2 host requirements
type: research-note
status: active
direction: direction-2
date: 2026-09-13
---

# Direction 2 host requirements

What convex-backend must provide to host a Skip graph natively, stated
from the Skip side. Plan `2026-09-10-1702` (backend-owned Skip graph for
one pre-registered room feed from committed row changes, version-gated
reads, silent-measurable fallback). Pairs with convex-backend
`research-poc-vehicle-and-harness.md`, `research-index-id-metadata.md`,
`research-native-operator-spec.md` (predates spikes; one-shot-operator
path explicitly rejected by the Dir2 spike in favor of persistent
maintenance), `research-backend-change-hook.md` (hook comparison
recommending `LogReader` tail with ts-grouped atomic apply).

## Skip needs from the host

- Long-lived `Mapper`/`Reducer` graph with inverse `remove` (precedent
  `AddTaskTotals.add/remove` in
  `examples/convex_reactive/skip/service.ts:68-87`); one combined input
  domain or scoped atomic update per
  `shared-prereqs-p-single-fork-per-atomic-unit`, backend-native
  reimplementation (same TS gap as Dir1 — see atomic-write gap doc).
- Committed-change feed grouped by transaction with seed/rebuild paths
  and a retention budget; version/health gate on reads with fallback to
  native execution that stays measurable
  (`incremental-materialized-cache-fallback-metrics`).
- Logical-work counters (not wall-clock):
  `incremental-materialized-cache-scaling-instrumentation` plus
  `incremental-materialized-cache-scaling-report` — unrelated-data size
  vs affected-fan-out axes, evaluated asymptotically against the
  strongest native baseline (indexes, counters, denormalization), not
  microsecond comparison; correctness per
  `incremental-materialized-cache-independent-correctness-check` via
  `shared-prereqs-q-language-neutral-methodology-spec`.
- Schema: stable-vs-internal index metadata split with lifecycle
  validation; `v.id` join edges with dangling-reference semantics
  (`incremental-materialized-cache-dangling-typed-reference`, `Unknown`
  fallback, cf. 1c vehicle `convex/chat.ts`); handshake per
  `incremental-materialized-cache-accelerated-handshake`.

## Explicit non-goals from the Skip side

- No general query-planner integration, no OCC/persistence-path changes,
  no multi-resource generalization: one feed, one room, persistent
  maintenance. The `QueryOperator::Skip` touch-list in
  `research-native-operator-spec.md` is orientation only.
- Tables/vehicle: `rooms/users/memberships/messages/likes` with implicit
  `by_id/by_creation_time` base views + enabled app indexes + `v.id`
  forward edges / indexed reverse fan-out, per the Dir2 plan.

## What this adds vs convex-backend notes

Those notes own backend seams, metadata, and harness; this doc is the
short Skip-side requirements list a backend host design checks off, plus
the reducer-with-inverse and combined-domain precedents to copy.

## Sources

- `convex-backend/docs/plans/IDENTIFIER-MAP.md`
  (`incremental-materialized-cache-*`, `shared-prereqs-q-*`)
- Plan `2026-09-10-1702-feat-skip-incremental-materialized-cache-spike-plan.md`
- `examples/convex_reactive/skip/service.ts:51-111`
- `research-skip-atomic-write-gap.md` (this directory)
