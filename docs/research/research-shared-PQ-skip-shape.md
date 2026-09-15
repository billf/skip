---
title: Shared P and Q Skip shape
type: research-note
status: active
direction: cross-cutting
date: 2026-09-13
---

# Shared P and Q Skip shape

Skip-side view of plan `2026-09-11-1159` (prerequisite tier beneath
1a/1b/1c/Dir2, not a spike): P = documented atomic multi-table write
convention + small TS library; Q = correctness-comparator +
fault-injection harness on the shared five-table proof-vehicle contract
(rooms/users/memberships/messages/likes; upstream commit `676813a47`
retired the two-table messages/users vehicle and its A1/A2 aggregate
labels as history). Pairs with convex-backend
`research-skip-source-state.md`, `research-poc-vehicle-and-harness.md`,
`research-spike-comparison.md`.

## P: merged envelope convention (build-once)

- Envelope per row: `{ts,deleted,component,table,_id,_creationTime,doc}`,
  Skip key `<comp>/<table>/<id>`, order `[_creationTime,_id]`.
   Tombstones are `[key,[]]` with `isInit:false`; in-value `ts` watermark
  (not session tick); tombstone GC + generation-fencing/pending-ledger
  per `data-sync-push-ktd-generation-fenced-ingestion` /
  `data-sync-push-ktd-scoped-replay-watermarks`
  (`shared-prereqs-p-generation-fencing-extension`).
- Library: envelope type, split-mapper (cf.
  `ProjectsOnly`/`TasksOnly` in
  `examples/convex_reactive/skip/service.ts:34-49` plus
  `TasksByProject/AddTaskTotals/AttachTotals` rejoin at `:51-111`),
  key/order helpers, watermark/tombstone helpers,
  `shared-prereqs-p-standalone-test-suite` synthetics,
  `shared-prereqs-p-no-runtime-change-required` statement;
  upstream-contribution candidate.
- Precedent to extract: `examples/convex_reactive/{skip/service.ts:34-89,
  160-161, shared/model.ts:16-18, DESIGN.md:114-118,314-315}`.
  Verified single-collection ceiling: `CollectionWriter.update:476-501` +
  `ServiceInstance.update:768-782` (no `updateMany`); `Runtime.sk:1038-1065`
  init-vs-patch rule.
- Dir2 note: backend-native maintenance does not consume the same
  external-adapter-shaped P/Q artifacts without further design work (per
  `1159` scope notes and `docs/plans/README.md` prerequisite tier).

## Q: comparator + fault harness

- Vehicle: shared five-table proof-vehicle contract
  (`shared-prereqs-q-poc-vehicle-driver`): rooms/users/memberships/
  messages/likes fixture, `memberships.by_room_user` /
  `messages.by_room` / `likes.by_message` indexes, canonical
  latest-50 room feed with active-membership filter, nullable sender
  (`null`, not `"Unknown"`), and per-message `likeCount`. The old A1
  per-user count / A2 joined latest-N labels are retired history.
- `shared-prereqs-q-settled-checkpoint-detector` on
  `Transition.end_version` / DataSync `UpToDate(ts)`;
  `shared-prereqs-q-dual-reader-wiring` (`ConvexClient`/`convex-test` vs
  SSE); `shared-prereqs-q-normalized-comparator` deep-equal +
  nullable-sender and exact-`likeCount` parity;
  `shared-prereqs-q-counter-timer-catalog` recorder (superset of
  the spike-comparison catalog; 1a populates only detector/dual-reader/
  comparator above). Metric profile per
  `research-core-metric-profile.md`: source rows/bytes, atomic batches,
  changed keys, dependent/reducer work required for 1b/1c/Dir2 and N-A
  for correctness-only 1a; stale duration optional (1b) / required
  (1c/Dir2); mismatch required everywhere; fallback required only for
  Dir2 (1c uses reconnect+stale instead). Collision map: 1b
  "rows+bytes delivered" ≡ 1c "revisions+bytes emitted"; keys
  reconciled ≡ keys added/changed/removed; atomic unit is Transition
  (1a) ≡ timestamp group (1c) ≡ page-group swap (1b) ≡ commit version
  (Dir2). Extensions: page-specific (1b sizes/splits/query-set),
  cursor-specific (1c resets/replays/truncations/wake-ups), index-gating
  (Dir2 base views, `v.id` edges, rebuild/progress).
  `shared-prereqs-q-fault-injection-fixture` eight common faults
  (disconnect-before-checkpoint, cursor expiry/invalid/ahead, table
  replacement, oversized transactions, `QueryFailed` vs `QueryRemoved`,
  slow-consumer/backlog exhaustion, mid-CDC restart, page-split +
  invalid-cursor reset) +
  `shared-prereqs-q-fault-assertion-helper`, with fault→state assertions
  per `research-publication-state-semantics.md` (freeze vs blank vs
  not-yet-loaded);
  `shared-prereqs-q-self-test-seeded-mismatches` proof built on the
  shared vectors below;
  `shared-prereqs-q-schema-matches-1c-jsonl` schema.
- Checkpoint gates per `research-logical-checkpoint-contract.md`
  (Q12 promotion): source batch applied, derived result published (never
  partial-as-current), native oracle observed with Q3 normalization,
  freshness disposition recorded. Bindings: 1a writes-settled excluding
  the failure checkpoint; 1b quiesced-or-revision-tagged same-revision;
  1c cursor-after-all-groups with frozen watermarks; Dir2 view ≥ causal
  watermark with cancel/deadline as non-comparison.
- Semantic vectors per `research-semantic-test-vectors.md` (V1 dangling
  sender → `sender: null`; V2 membership flip; V3 like add/remove with
  liked-user delete keeping count; V4 51-row boundary + `_id` tiebreak;
  V5 deletes per kind; V6 atomic membership+like transaction), 1–3 rows
  each (51 for V4), manifest versioned with major on
  predicate/projection/order/limit/index change. Sizing stays separate
  (N/K/F geometric sweeps).
- No comparator exists in Skip today (`crates/common/src/comparators/`
  cited in `1159` as negative proof); reference readers are
  `convex-tutorial convex/{schema.ts:6-12,chat.ts,chat.test.ts}` and the
  convex adapter `FakeConvex`/`recorder()` harness
  (`adapters/convex/src/index.test.ts:18-80`).
- Timer chain shared with the measurement framework:
  `commit(ack)→readable→delivered→applied→published`; counts plus full
  chain reported alongside O(K) vs O(N) curves.

Probe: `shared-prereqs-p-standalone-test-suite` synthetics
(envelope round-trip, tombstone GC, fencing) plus a
`shared-prereqs-q-self-test-seeded-mismatches` proof over vectors
V1–V6 that the comparator fails loudly on deliberately diverged state.

## Sources

- `convex-backend/docs/plans/IDENTIFIER-MAP.md` (all P/Q anchors above)
- `convex-backend/research/skip-convex-integration/research-core-metric-profile.md`
  (required/optional/N-A, collision map, extensions)
- `convex-backend/research/skip-convex-integration/research-logical-checkpoint-contract.md`
  (four gates, bindings, Q12 additions)
- `convex-backend/research/skip-convex-integration/research-publication-state-semantics.md`
  (vocabulary, fault→state matrix)
- `convex-backend/research/skip-convex-integration/research-semantic-test-vectors.md`
  (V1–V6, coverage, manifest parity)
- Plan `2026-09-11-1159-feat-skip-shared-prerequisites-plan.md`
- `skipruntime-ts/core/src/index.ts:476-501,768-782`
- `skipruntime-ts/skiplang/core/src/Runtime.sk:1038-1065`
- `skipruntime-ts/adapters/convex/src/index.test.ts:18-80`
- `examples/convex_reactive/skip/service.ts:34-111,151-163`
- `examples/convex_reactive/shared/model.ts:16-24`
- `examples/convex_reactive/DESIGN.md:114-118`
