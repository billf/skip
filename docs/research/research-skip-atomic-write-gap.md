---
title: Skip atomic-write gap
type: research-note
status: active
direction: cross-cutting
date: 2026-09-13
---

# Skip atomic-write gap

All four spikes hit the same structural gap: Skip Runtime's public
TypeScript API exposes no atomic write spanning several external
collections — only single-collection updates. Each plan proposes its own
workaround without a shared resolution. This doc states the gap from
Skip-repo evidence and blesses the two viable options.

## Evidence: one collection per tick

- `core/src/index.ts:476-487` `CollectionWriter.update` forks one
  uuid-named context, runs one `CollectionWriter__update`, merges. N
  writers = N fork/merge ticks; subscribers observe the intermediate.
- `core/src/index.ts:768-782` `ServiceInstance.update(collection,entries)`
  takes one collection name; no batch/multi variant.
- `server/src/rest.ts:86-103` `PATCH /v1/inputs/:collection` → single
  `service.update()`; N collections need N calls, not atomic.
- `helpers/src/rest.ts:186-206` `SkipServiceBroker.update/deleteKey`
  wraps the same single-collection `PATCH`.
- `fork`/`merge` on `ToBinding` are public but `CollectionWriter`
  internals are private; there is no public
  `updateMany([(dir,values,isInit)])` or exposed fork handle today.

## Options for spikes (atomic-single-tick in each plan)

(a) New runtime/FFI batch primitive — needs Skip-side design, out of
spike scope. (b) Single merged external resource holding a tagged union
domain (e.g. `WorkspaceRow` project|task) with one `isInit` granularity —
loses per-query init granularity but preserves atomicity in one tick.
(c) Per-query ticks + downstream `merge(...).mapReduce()` — eventual
consistency, not atomic; acceptable only where the demo tolerates a mixed
intermediate.

Recommendation for 1a/1b/1c: (b). Precedent is
`examples/convex_reactive/skip/service.ts:34-49,151-161`:
`ProjectsOnly`/`TasksOnly` split one `workspace` input domain, and
`DESIGN.md:114-118` documents why one combined query result through one
`callbacks.update` call avoids mixed Skip input. The shared-P/Q `P`
convention (`research-shared-PQ-skip-shape.md`) standardizes this tagged
envelope so spikes do not each re-solve it.

## Teardown ordering pattern to copy

`adapters/postgres/src/index.ts:45-59` `chainInstanceOp` serializes
per-instance setup/teardown so teardown never interleaves with in-flight
setup. `adapters/convex/src/index.ts:244-363` serializes deliveries on a
`delivery` chain with generation fencing and `release`/`drain`, and
`shutdown():378-386` releases then `Promise.allSettled(draining)` before
closing the client. Any new push source (1c) must copy one of these; the
convex adapter's pre-`drain` gap (unsubscribe drops synchronously) is
called out in `research-convex-adapter-v1.md` as the bug not to repeat.

Probe: subscribe two resources, deliver query A then query B in separate
ticks with a subscriber asserting cross-query invariant; observe the
intermediate violation. Repeat through one merged domain; invariant holds.

## What this adds vs convex-backend notes

Convex-backend `research-skip-atomic-write.md` and the atomic-apply
requirements already frame options (a)/(b)/(c) —
`sync-protocol-client-atomic-transition-apply`,
`data-sync-push-atomic-revision-group-apply`,
`shared-prereqs-p-single-fork-per-atomic-unit` (plus 1b's page-group
swap and Direction 2's backend-native equivalent, neither with a map
row). This doc confirms from Skip-repo lines that
(a) does not exist, blesses (b) with the `workspace` precedent, and names
the `chainInstanceOp`/delivery-chain pattern a new adapter must copy.

## Sources

- `skipruntime-ts/core/src/index.ts:469-533,768-807`
- `skipruntime-ts/server/src/rest.ts:86-103`
- `skipruntime-ts/helpers/src/rest.ts:186-206`
- `skipruntime-ts/adapters/postgres/src/index.ts:42-59,280-314`
- `skipruntime-ts/adapters/convex/src/index.ts:244-386`
- `examples/convex_reactive/skip/service.ts:34-49,151-163`
- `examples/convex_reactive/DESIGN.md:114-123`
