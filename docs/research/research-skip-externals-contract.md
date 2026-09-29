---
title: Skip externals contract
type: research-note
status: active
direction: foundation
date: 2026-09-13
---

# Skip externals contract

What a Convex source must obey to feed Skip, anchored to this repo's
implementation. Pairs with convex-backend
`research-skip-externals-adapter.md` and `research-skip-engine.md`; what is
new here is exact Skip-repo lines and the `isInit` reconciliation rule.

## `ExternalService` is per-resource, callback-driven

`skipruntime-ts/core/src/api.ts:450-486` defines `ExternalService`:

- `subscribe(instance, resource, params: Json, callbacks)` with
  `update(updates: Entry<Json,Json>[], isInit: boolean) => Promise<void>`
  and `error(error: unknown) => void`.
- `unsubscribe(instance): void`, `shutdown(): Promise<void>`.
- Wiring is per-resource: `core/src/index.ts:146-171,1211-1226`,
  `skiplang/core/src/Runtime.sk:398-534`. N resources = N writers,
  N subscriptions, N ticks.

`Context.useExternalResource` (`api.ts:441`) is how `createGraph` consumes
it. Live precedent: `examples/convex_reactive/skip/service.ts:151-155`
subscribes to one `workspace` external collection, then splits it with
mappers (`ProjectsOnly`, `TasksOnly` at `:34-49`).

## `isInit:true` reconciles natively and minimally

- `skiplang/core/src/Runtime.sk:1038-1065` `writeInCollection`: `isInit:true`
  enumerates current keys, writes the full array, deletes leftovers as
  `[key,[]]`; `isInit:false` is a patch (stale keys remain). `isInit` is a
  caller assertion of full-snapshotness, not persisted state — partial
  snapshot + `true` = mass delete. One call = one reactive tick.
- `skiplang/prelude/src/skstore/EagerDir.sk:1717-1729` `writeEntry`:
  `native_eq(new,old)==0` returns early — no dirty marking, no reducer
  work. Changed keys go through set + reducer maintenance + child
  scheduling. Cost of `true` is key enumeration + per-key compare (mostly
  early-return) + full snapshot over FFI; unchanged keys do not
  re-propagate. Correct iff the writer sends the query's full result.
- Streaming reflection: `server/src/rest.ts:129-137` maps `isInitial` to
  SSE `event:init` vs `event:update` with `id:watermark`.

## `CollectionWriter` and `ServiceInstance` are single-collection

- `core/src/index.ts:469-533` `CollectionWriter.update(values,isInit)`:
  fork uuid-named context, `SkipRuntime_CollectionWriter__update` over FFI
  (`binding.ts`, `FFI.sk`, `Runtime.sk:834-854`), then `merge()`; on throw,
  `abortFork()`. `needGC` forbids writes inside mapper/reducer.
- `core/src/index.ts:768-782` `ServiceInstance.update(collection,entries)`
  batches single input collections only — no `updateMany` through current
  version. REST mirrors it: `server/src/rest.ts:86-103`
  `PATCH /v1/inputs/:collection` → one `service.update()` call.
- Contract test harness: `skipruntime-ts/tests/src/tests.ts:588-632`
  `MockExternal` exercises the `cb(updates,isInit)` shape.

Probe: drive `MockExternal` (or the convex adapter's `FakeConvex` in
`adapters/convex/src/index.test.ts:18-58`) with full snapshot +
`isInit:true`, then same snapshot again; second delivery should produce no
downstream recompute beyond enumeration/compare.

## What this adds vs convex-backend notes

Convex-backend `research-skip-atomic-write.md` already describes the
`isInit:true` + fork/merge path. This doc pins it to verifiable Skip-repo
lines above and to the `workspace` precedent, so spikes 1a/1b/1c/Dir2 can
cite behavior without re-deriving it.

## Sources

- `skipruntime-ts/core/src/api.ts:440-486`
- `skipruntime-ts/core/src/index.ts:469-533,768-807`
- `skipruntime-ts/skiplang/core/src/Runtime.sk:398-534,834-854,1038-1073`
- `skiplang/prelude/src/skstore/EagerDir.sk:1717-1729`
- `skipruntime-ts/server/src/rest.ts:86-137`
- `examples/convex_reactive/skip/service.ts:34-49,151-163`
