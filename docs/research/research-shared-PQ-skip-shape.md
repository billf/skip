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
fault-injection harness on frozen `convex-tutorial` vehicle. Pairs with
convex-backend `research-skip-source-state.md`,
`research-poc-vehicle-and-harness.md`, `research-spike-comparison.md`.

## P: merged envelope convention (build-once)

- Envelope per row: `{ts,deleted,component,table,_id,_creationTime,doc}`,
  Skip key `<comp>/<table>/<id>`, order `[_creationTime,_id]`.
  Tombstones are `[key,[]]` with `isInit:false`; in-value `ts` watermark
  (not session tick); tombstone GC + generation-fencing/pending-ledger
  per 1c KTD7-KTD9 bar (P9).
- Library: envelope type, split-mapper (cf.
  `ProjectsOnly`/`TasksOnly` in
  `examples/convex_reactive/skip/service.ts:34-49` plus
  `TasksByProject/AddTaskTotals/AttachTotals` rejoin at `:51-111`),
  key/order helpers, watermark/tombstone helpers, P7 synthetic tests, P8
  no-FFI statement; upstream-contribution candidate.
- Precedent to extract: `examples/convex_reactive/{skip/service.ts:34-89,
  160-161, shared/model.ts:16-18, DESIGN.md:114-118,314-315}`.
  Verified single-collection ceiling: `CollectionWriter.update:476-501` +
  `ServiceInstance.update:768-782` (no `updateMany`); `Runtime.sk:1038-1065`
  init-vs-patch rule.
- Dir2 note: backend-native maintenance does not consume the same
  external-adapter-shaped P/Q artifacts without further design work (per
  `1159` scope notes and `docs/plans/README.md` prerequisite tier).

## Q: comparator + fault harness

- Vehicle: frozen `convex-tutorial messages/users` + A1 per-user count /
  A2 joined latest-N.
- Q1 settled predicate on `Transition.end_version` / DataSync
  `UpToDate(ts)`; Q2 dual-reader (`ConvexClient`/`convex-test` vs SSE);
  Q3 normalized deep-equal + `Unknown` parity; Q5 recorder (superset of
  the spike-comparison catalog; 1a exempt); Q6 eight common faults
  (disconnect-before-checkpoint, cursor expiry/invalid/ahead, table
  replacement, oversized transactions, `QueryFailed` vs `QueryRemoved`,
  slow-consumer/backlog exhaustion, mid-CDC restart, page-split +
  invalid-cursor reset) + Q7 assertions; Q8 seeded-mismatch proof; Q11
  1c-JSONL-compatible schema.
- No comparator exists in Skip today (`crates/common/src/comparators/`
  cited in `1159` as negative proof); reference readers are
  `convex-tutorial convex/{schema.ts:6-12,chat.ts,chat.test.ts}` and the
  convex adapter `FakeConvex`/`recorder()` harness
  (`adapters/convex/src/index.test.ts:18-80`).
- Timer chain shared with the measurement framework:
  `commit(ack)→readable→delivered→applied→published`; counts plus full
  chain reported alongside O(K) vs O(N) curves.

Probe: P7 synthetics (envelope round-trip, tombstone GC, fencing) plus a
Q8 seeded mismatch proving the comparator fails loudly on deliberately
diverged state.

## Sources

- Plan `2026-09-11-1159-feat-skip-shared-prerequisites-plan.md`
- `skipruntime-ts/core/src/index.ts:476-501,768-782`
- `skipruntime-ts/skiplang/core/src/Runtime.sk:1038-1065`
- `skipruntime-ts/adapters/convex/src/index.test.ts:18-80`
- `examples/convex_reactive/skip/service.ts:34-111,151-163`
- `examples/convex_reactive/shared/model.ts:16-24`
- `examples/convex_reactive/DESIGN.md:114-118`
