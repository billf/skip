---
title: Postgres adapter reference
type: research-note
status: active
direction: foundation
date: 2026-09-13
---

# Postgres adapter reference

The push adapter a Convex push source should imitate for lifecycle, and
contrast for data path. `skipruntime-ts/adapters/postgres/src/index.ts`
(335 lines) is the mature `ExternalService` with per-instance trigger
channels, per-key refresh, and serialized setup/teardown.

## Data path: init snapshot, then per-key refresh

- `subscribe:150-164`: required `params.key{col,type}`, optional
  `syncHistoricData` (default true). `syncHistoricData:false` sends
  `update([],true)` — new rows only, for append-only tables.
- `initData:177-192`: default `SELECT *`, grouped into
  `Map<key,rows>`, one `callbacks.update(entries,true)`.
- `setupPgNotify:194-245`: per-instance trigger function + `LISTEN`,
  `CREATE TRIGGER ... AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW`.
  Marks `open_instances` only after all queries succeed; on failure drops
  the function (`DROP FUNCTION ... CASCADE`) so no durable leak.
- `onNotification:247-275`: on NOTIFY for a known (or setup-in-flight)
  instance, runs key-scoped `key.select(table,payload)` (`util.ts`), then
  `callbacks.update([[k,rows]],false)`. Per-key `SELECT` keeps steady-state
  work proportional to changed keys, not table size — the property spikes
  1b/1c chase for Convex.
- Key types: `util.ts` `validateKeyParam` + `PostgresPKey` (TEXT / INT
  family); payload parsed as string vs `Number` accordingly.

## Lifecycle pattern to copy

- `chainInstanceOp:45-59`: each per-instance op runs only after the
  previous one for that instance settles; entry removed when the chain tip
  completes. Setup (`initData` + listener + trigger) runs as one chained
  op (`:280-292`); `unsubscribe:295-314` chains the `DROP FUNCTION` behind
  in-flight setup so a still-setting-up subscription is torn down once
  ready instead of outliving its unsubscription; `shutdown:316-334`
  refuses new subscriptions, drains `instance_ops`, drops remaining
  functions, ends the client.
- Failure visibility: `client.on("error")` (`:101-111`) marks `broken`,
  clears channels, so later subscriptions fail loudly instead of reusing
  dead channels; recovery = fresh `PostgresExternalService`. The convex
  adapter's inert-after-cap rule is the same idea over a different
  transport.
- Contrast `helpers/src/external.ts:61-121` `PolledExternalService`:
  `call(true)` once then `setInterval(call(false))` — polling, no
  channels, no per-key path. Spikes must beat polling, not imitate it.
- Contrast `adapters/kafka/src/index.ts`: always
  `update(entries,false)`, `eachBatch` grouped — log tail without init
  reconciliation.

Probe: subscribe with `syncHistoricData:false`, insert one row, assert one
`[[k,rows]],false` delivery; unsubscribe mid-setup and assert the trigger
function is dropped (no leak, no duplicate on retry).

## What this adds vs convex-backend notes

Convex-backend plans cite postgres only as prior art. This doc gives spike
implementers the exact lifecycle lines to copy (`chainInstanceOp`,
chained setup/teardown, loud-broken semantics) and the per-key refresh
shape that makes 1b page-regions and 1c document deltas worthwhile.

## Sources

- `skipruntime-ts/adapters/postgres/src/index.ts:32-335`
- `skipruntime-ts/adapters/postgres/src/util.ts`
- `skipruntime-ts/adapters/postgres/README.md`
- `skipruntime-ts/adapters/kafka/src/index.ts`
- `skipruntime-ts/helpers/src/external.ts:61-121`
