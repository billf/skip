---
title: Skip-side research for Convex integration spikes
type: research-index
status: active
direction: foundation
date: 2026-09-13
---

# Skip-side research for Convex integration spikes

Skip-native grounding for the five plans in
`convex-backend/docs/plans/` (1a sync-protocol client, 1b paginated source,
1c Data Sync push source, Direction 2 materialized cache, shared P/Q
prerequisites). Companion to
`convex-backend/research/skip-convex-integration/` — it does not duplicate
those 20 docs, it supplies the Skip-repo half: exact files, line-anchored
semantics, and the constraints a spike implementation will hit.

Scope statements:

- **Skip repo only.** Paths below are in this repository unless noted.
  Convex-backend behavior is cited, not re-proven.
- **No commitment.** Spike-enabling research, not a maintainer roadmap.
  Each doc states what it adds versus the convex-backend note it pairs with.
- **Correctness bar is shared.** A Skip aggregate must match an independent
  native Convex query at settled checkpoints; Skip-internal consistency
  alone is never sufficient.

## Documents

Foundation (read first):

- `research-skip-externals-contract.md` — `ExternalService`, `update` /
  `isInit`, `CollectionWriter`, `ServiceInstance`.
- `research-skip-atomic-write-gap.md` — no public multi-collection atomic
  write; combined-domain workaround and `chainInstanceOp` pattern.
- `research-convex-adapter-v1.md` — current `@skip-adapter/convex`
  snapshot-to-delta boundary, recovery, value domain.
- `research-postgres-reference.md` — push adapter reference
  (`LISTEN/NOTIFY`, per-key `SELECT`, setup/teardown serialization).
- `research-control-streaming-boundary.md` — `runService` control vs
  streaming ports; gateway rules from `examples/convex_reactive/DESIGN.md`.

Per-spike Skip shape:

- `research-1a-skip-mapping.md` — Transition as one atomic `isInit:true`
  write, no bridge diffing.
- `research-1b-page-regions.md` — pages as separate input regions,
  atomic split-swap requirement.
- `research-1c-push-contract.md` — push revisions as one atomic batch
  onto a retained join+reducer graph.
- `research-dir2-host-requirements.md` — what a backend-native Skip host
  must provide (long-lived graph, version gate, work counters).

Shared:

- `research-shared-PQ-skip-shape.md` — P envelope convention + Q
  comparator/harness as seen from Skip.

## Sources

- `convex-backend/docs/plans/README.md` plus the five plan files.
- `convex-backend/research/skip-convex-integration/overview.md`,
  `README.md`, `research-skip-atomic-write.md`,
  `research-skip-engine.md`.
- `examples/convex_reactive/DESIGN.md` — v1 snapshot contract, control-API
  section, production plan steps 1-7.
