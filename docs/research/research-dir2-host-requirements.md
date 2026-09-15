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

- Input per `incremental-materialized-cache-committed-row-change-input`
  (ordered post-commit rows only; no polling/rerun/diff); visibility per
  `incremental-materialized-cache-transaction-atomic-visibility`;
  maintenance per
  `incremental-materialized-cache-incremental-maintained-operators`
  (long-lived `Mapper`/`Reducer` graph with inverse `remove`, precedent
  `AddTaskTotals.add/remove` in
  `examples/convex_reactive/skip/service.ts:68-87`); one combined input
  domain or scoped atomic update per
  `shared-prereqs-p-single-fork-per-atomic-unit`, backend-native
  reimplementation (same TS gap as Dir1 — see atomic-write gap doc).
- Committed-change feed grouped by transaction with seed/rebuild paths
  and a retention budget; version/health gate on reads with fallback to
  native execution that stays measurable
  (`incremental-materialized-cache-fallback-metrics`). Freshness per the
  clarified contract: the required version is the connection's causal
  sync watermark (max observed commit); a healthy behind-view waits only
  until catch-up, read cancel/deadline, or unhealthiness — the latter two
  fall back silently with reason recorded. Recovery fence: one change
  before the consistent-snapshot cursor plus one after, both covered
  before acceleration is eligible.
- Logical-work counters (not wall-clock):
  `incremental-materialized-cache-scaling-instrumentation` plus
  `incremental-materialized-cache-scaling-report` — unrelated-data size
  vs affected-fan-out axes, evaluated asymptotically against
  `incremental-materialized-cache-idiomatic-convex-baseline` (indexes,
  counters, denormalization), not microsecond comparison; correctness
  per `incremental-materialized-cache-independent-correctness-check` via
  `shared-prereqs-q-language-neutral-methodology-spec`; surface
  unchanged per `incremental-materialized-cache-native-surface-unchanged`.
- Index split per `research-static-vs-dynamic-indexes.md`: every
  direction assumes the static set present + enabled
  (`memberships.by_room_user`, `messages.by_room`, `likes.by_message`
  plus per-table `by_id`/`by_creation_time`; 1a plain per-table queries,
  1b `messages.by_room` pagination, 1c fixed five-table selection).
  Only Direction 2 tests lifecycle:
  `incremental-materialized-cache-implicit-base-index-views`
  plus `incremental-materialized-cache-indexed-maintained-lookups` with
  `incremental-materialized-cache-index-eligibility-validation` (AE6:
  staged/removed/disabled/incompatible → ineligible, reason in
  metrics); `incremental-materialized-cache-validated-id-join-edges`
  and `incremental-materialized-cache-reverse-join-index` with
  `incremental-materialized-cache-missing-target-join-semantics`
  (`incremental-materialized-cache-dangling-typed-reference`, `null`-sender
  fallback, cf. 1c vehicle `convex/chat.ts`); view scoped per
  `incremental-materialized-cache-preregistered-room-message-feed`;
  handshake per
  `incremental-materialized-cache-accelerated-handshake`.

## Explicit non-goals from the Skip side

- No general query-planner integration, no OCC/persistence-path changes,
  no multi-resource generalization: one feed, one room, persistent
  maintenance. The `QueryOperator::Skip` touch-list in
  `research-native-operator-spec.md` is orientation only.
- Tables/vehicle: `rooms/users/memberships/messages/likes` with implicit
  `by_id/by_creation_time` base views + enabled app indexes + `v.id`
  forward edges / indexed reverse fan-out, per the Dir2 plan.

## Anti-confusion (lifecycle, not index state)

Per `research-static-vs-dynamic-indexes.md`: 1b `InvalidCursor` full
reset is query-cursor lifecycle; 1c replacement/truncation is Data Sync
lifecycle (generation swap); 1a `QueryFailed`/`QueryRemoved`/
not-yet-loaded is subscription state. None implies `_index`
staged/disabled. Open: whether 1b/1c rebuilds assert "indexes still
enabled" or that stays D2-only; whether 1b needs any index beyond
`by_room`.

## What this adds vs convex-backend notes

Those notes own backend seams, metadata, and harness; this doc is the
short Skip-side requirements list a backend host design checks off, plus
the reducer-with-inverse and combined-domain precedents to copy.

## Sources

- `convex-backend/research/skip-convex-integration/research-static-vs-dynamic-indexes.md`
  (static set, D2-only lifecycle, forward/reverse rules, anti-confusion)
- `convex-backend/research/skip-convex-integration/research-publication-state-semantics.md`
  (D2 wait-vs-fallback, counted fallback)
- `convex-backend/docs/plans/IDENTIFIER-MAP.md`
  (`incremental-materialized-cache-*`, `shared-prereqs-q-*`)
- Plan `2026-09-10-1702-feat-skip-incremental-materialized-cache-spike-plan.md`
- `examples/convex_reactive/skip/service.ts:51-111`
- `research-skip-atomic-write-gap.md` (this directory)
