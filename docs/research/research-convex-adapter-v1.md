---
title: Convex adapter v1 boundary
type: research-note
status: active
direction: direction-1
date: 2026-09-13
---

# Convex adapter v1 boundary

Teardown of the shipped `@skip-adapter/convex` (`skipruntime-ts/adapters/convex/src/index.ts`,
`README.md`, `index.test.ts`) and the `examples/convex_reactive` precedent.
This is the baseline spikes 1a/1b/1c improve on — snapshot transport with
reactive diffing — and the source of two contracts a new adapter must keep.

## Snapshot in, keyed deltas out

- `index.ts:133-163` `diffSnapshot(previous, rows, getKey)`: emits only
  new/changed rows (`!isDeepStrictEqual`) plus `[oldKey,[]]` tombstones for
  vanished keys; throws on duplicate keys and non-string keys; calls
  `assertSkipJson` per row.
- `index.ts:307-333` `onRows`: serializes Convex observer callbacks on a
  `delivery` chain (Convex's callback is not an async queue), diffs, then
  one `callbacks.update(result.updates, isInitial)` per snapshot.
  First delivery per subscription is `isInitial:true`; later ones `false`.
- Generation fencing (`generation`, `sourceGeneration`) drops late
  deliveries from a replaced subscription; `released` flag drops post-teardown work.
- Live shape: `examples/convex_reactive/convex/workspace.ts:4-31` one
  `snapshot` query returns projects+tasks as a tagged `WorkspaceRow`
  (`shared/model.ts:16-18`); `skip/service.ts:135-163` registers it as one
  `workspace` resource with `getKey: row => row.key` and empty-params guard.

## Recovery is snapshot re-establishment, not replay

- Rejected `callbacks.update` → `reportError` + `resubscribe()`
  (`:274-305`): detach, bump generation, clear mirror after backoff, attach
  fresh so Convex redelivers a cached result as a new initial snapshot.
- Capped: `maxResubscribeAttempts=5`, `resubscribeBackoffMs=100` doubling
  (`:178-180,208-210,289-302`); after cap the instance reports through
  `callbacks.error` and goes inert — unsubscribe/subscribe to restart.
  An accepted delivery resets the count (`:319`).
- `README.md:7-9` states the contract: no durable change-log cursor;
  restart or rejected-update recovery establishes a new subscription and
  fresh initial snapshot.
- Tests: `index.test.ts` `FakeConvex` + `recorder()` cover init-once,
  rejected-init retry, rejected-update → fresh `isInitial:true`,
  stale-generation drop, normal reconnect diffs with `isInitial:false`.

## Two contracts the example never had to state

Value domain. `index.ts:108-131` `assertSkipJson` rejects `bigint`
(`v.int64`) and `ArrayBuffer`/views (`v.bytes`) with named `TypeError`s —
because Skip `Json` cannot represent them (`exportJSON` throws opaquely on
the former, silently exports `{}` on the latter). Callers wanting them
must supply a row encoder. Spikes must keep this rejection at the boundary.

Teardown ordering. `unsubscribe:373-376` releases synchronously without
draining the in-flight `delivery` chain, so a queued `callbacks.update`
can run after Skip tore the collection down. `shutdown:378-386` does drain
(`release` then `Promise.allSettled(draining)`), which is the pattern to
copy. A new adapter should serialize per-instance setup/teardown against
the delivery chain as `@skip-adapter/postgres` does with
`chainInstanceOp`, and drop late deliveries for a released instance rather
than reporting them as errors.

Tenant scope. `index.ts:20-21,177,198-211` freezes
`ConvexServiceScope{tenantId}` at construction; `TypedConvexReactiveResource`
(`:28-38`) plus `argsFromParams(params, scope)` (`:34-37,236-242`) must
inject the tenant and reject caller overrides; the Convex query must verify
identity. `README.md:36-43` states the rule. Demo scope `tenantId:"demo"`
(`service.ts:144`) is the placeholder a real service replaces with OIDC/JWT
service identity (see `DESIGN.md` production plan step 4).

## What this adds vs convex-backend notes

Convex-backend `research-skip-externals-adapter.md` tore down the older
`billf/convex/adapter` branch. This doc covers the shipped
`@skip-adapter/convex@0.0.23` that replaced it, with the recovery cap,
frozen scope, and value-domain rejection a spike reuses or deliberately
departs from.

## Sources

- `skipruntime-ts/adapters/convex/src/index.ts:13-387`
- `skipruntime-ts/adapters/convex/src/index.test.ts:1-484`
- `skipruntime-ts/adapters/convex/README.md:1-50`
- `skipruntime-ts/adapters/convex/package.json`
- `examples/convex_reactive/skip/service.ts:117-164`
- `examples/convex_reactive/shared/model.ts:16-24`
- `examples/convex_reactive/convex/workspace.ts:1-92`
- `examples/convex_reactive/DESIGN.md:95-160`
