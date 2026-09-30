---
title: Direction 2 Skip evidence
type: research-note
status: active
direction: direction-2
date: 2026-09-15
---

# Direction 2 Skip evidence

Every Skip-repo fact the backend-native materialized cache
(`convex-backend/docs/plans/2026-09-10-1702-feat-skip-incremental-materialized-cache-spike-plan.md`,
implementation-ready per `36f8bfa51`) needs for a decision, its
implementation, or its validation — organized by that plan's KTDs and
spike units. Anchors below are from
`convex-backend/docs/plans/IDENTIFIER-MAP.md`. Paths are in this
repository unless prefixed `convex-backend:`.

Path convention: short roots expand to repo-relative paths —
`addon/`, `wasm/`, `server/`, `core/`, `tests/`, `adapters/`,
`helpers/` live under `skipruntime-ts/`; `skiplang/ffi/` and the
`skiplang/core/` sources (`Runtime.sk`, `BaseTypes.sk`) live under
`skipruntime-ts/skiplang/`; `prelude/` lives under top-level
`skiplang/` (e.g. `skiplang/prelude/src/skstore/EagerDir.sk`);
`examples/` is top-level; `crates/` is convex-backend. Bare
`Runtime.sk` / `Context.sk` / `FFI.sk` line refs mean
`skipruntime-ts/skiplang/core/src/Runtime.sk`,
`skiplang/prelude/src/skstore/Context.sk`, and
`skipruntime-ts/skiplang/ffi/src/FFI.sk` respectively.

## KTD1 — Node child host

Decision: Node is the supported, demonstrated integration surface;
direct Rust FFI is unsupported and explicitly out of spike scope
("impossible" is unproven — the runtime also exports a C ABI that the
addon consumes: `addon/src/tojs.cc:9-39` declares an `extern "C"` block
(`SkipRuntime_CollectionWriter__update` at :11-12,
`SkipRuntime_initService` at :26, `SkipRuntime_Collection__*` at
:28-39, and friends) — but that ABI is not a supported Rust API). `addon/src/common.h:57-73` defines every runtime
handle (`SKError`, `SKObstack`, `CJSON`, `SKContext`, `SKService`, …)
as `void*`; `addon/src/main.cc:24-33` exports a NAPI module only.
`addon/package.json` pins linux/x64+arm64/glibc with a
`libskipruntime` version-match install contract
(`addon/README.md:12-34`); a minimal host depends on component packages
directly, not `@skiplabs/skip` (`addon/README.md:36`). The WASM build
still needs a JavaScript host and environment
(`wasm/src/node.ts:1-10`, `wasm/src/skipruntime_init.ts:14-46`), and
`crates/isolate` is per-invocation, so the demonstrated way to hold a
long-lived graph is a backend-supervised Node child over a private
socket — a supported choice, not a proof that no other exists.

Implementation: mirror `server/src/server.ts:105-138` (platform switch
`wasm` default / `native` opt-in, then `runtime.initService(service)`),
the minimal host template
`examples/chatroom/reactive_service/{package.json:11-18,server.js:1-4}`,
and the transactional init in `core/src/index.ts:1398-1422`
(fork → register → `SkipRuntime_initService` → merge, abort on error).
`ServiceDefinition` wiring (`core:106-202`, externals keyed
`${external}/${instance}`).

Validation: `tests/native_addon/test.ts:1-16` empty-service smoke plus
the dual runners `tests/src/addon.spec.ts:1-4` /
`tests/src/wasm.spec.ts:1-4` through `initTests` — the host-startup
shape U1 repeats.

## KTD2 — LogReader tail feed

No Skip code decides this (backend-owned write log). The Skip-side
contract it must satisfy lives in
`research-atomic-source-batch.md` and
`research-skip-atomic-write-gap.md`: one commit = one batch, opaque
monotonic version per direction, `_id`-only tombstones resolved via
retained values.

## KTD3 — one combined collection via `ServiceInstance.update`

Decision: `core/src/index.ts:772-811` — `ServiceInstance.update`
takes one collection, forks a uuid context, runs
`SkipRuntime_Runtime__update`, merges (`abortFork` on error). It has
**no `isInit` parameter** — contrast `CollectionWriter.update`
(`:476-501`, `update(values,isInit)`) and the FFI pair
(`skiplang/ffi/src/FFI.sk:136` with `isInit` vs `:696` without).
`Runtime.sk:1071` confirms `update` always writes with `isInit=false`.
So a seed is one update on a fresh generation (nothing to reconcile),
steady-state deletes are explicit `[key,[]]` entries, and a
non-monotonic batch timestamp must be rejected by the host, not the
runtime. This closes Direction 2's atomicity branch: combined single
collection, P1-P3 reimplemented natively, no P import, no new runtime
primitive (`shared-prereqs-p-no-runtime-change-required`).

Implementation: copy the merged-domain + split pattern from
`examples/convex_reactive/skip/service.ts:34-49,151-163`
(`ProjectsOnly`/`TasksOnly` split of one `workspace` input), the
serialized delivery chain with generation fencing from
`adapters/convex/src/index.ts:244-363`, and the per-instance
setup/teardown serialization (`chainInstanceOp`) from
`adapters/postgres/src/index.ts:45-59`.

Validation: `adapters/convex/src/index.test.ts:18-84`
(`FakeConvex` + `recorder`) is the harness shape for atomic-batch
tests: init-once, rejected-batch recovery, stale-generation drop.
U1's one-notification test is a start, not the proof: require an
explicit test that a notifier cannot observe an intermediate graph
state and cannot re-enter an un-serialized runtime operation.
`ServiceInstance.update` (`core:772-811`) forks, awaits the returned
work handles (`Promise.all`), then merges — but the research does not
establish the ordering of merge vs notifier delivery, callback
reentrancy, or concurrent read/close against that sequence, so the
test must pin it.

## Value boundary — Convex post-images into Skip JSON

The host feed consumes post-image documents, but only Skip's
JSON-facing side is researched here. Lossless encoding is a host
contract the plan must state: document IDs travel as strings (safe);
`v.int64` decodes to `bigint` and `v.bytes` to `ArrayBuffer`/views,
both rejected at the boundary by `assertSkipJson`
(`adapters/convex/src/index.ts:108-131`) with a named error demanding
a row encoder — the host needs that encoder (int64→string,
bytes→string) before same-version comparison means anything. Missing
fields (`undefined`) never survive JSON export and must be normalized
explicitly (absent vs `null` is a comparison-visible distinction, and
the vehicle uses `null` senders deliberately). Either the contract
enumerates the lossless mapping for IDs, integers, bytes, missing
fields, and any sentinels, or the proof vehicle deliberately
restricts itself to a known-safe subset (strings, doubles, booleans,
`null`, arrays, plain objects) and states the restriction. Without
one of the two, an encoding mismatch invalidates native-oracle
comparison before graph logic is exercised.

## KTD4 — seed-then-tail rebuild, no persistence

`Runtime.sk:856` (`CollectionWriter.update_` no-ops on a missing dir)
makes generation reset trivially a fresh seed. Fork rollback backing
re-seed lives in `prelude/src/skstore/Context.sk:2418`
(`mergeForkNoGc`, `ConcurrentFork` on divergence) and `:2467`
(`removeForkNoGc` rollback). The fence-and-serve policy itself
(seed at S, tail from S+1, serve at catch-up fence; re-seed on any
failure/out-of-retention) is backend lifecycle — trust upstream, with
the runtime semantics above as the reason it needs no checkpoint store.

## KTD5 — eligibility validation

The declaration↔registry check pattern to copy is
`TypedConvexReactiveResource` + `argsFromParams`
(`adapters/convex/src/index.ts:28-60`): typed surface, validated
params, frozen scope, heterogeneous registry erasure. Registry-only
tail (subscribe without apply) mirrors subscribing an external
resource and gating writes on validation — `Context.useExternalResource`
(`core/src/api.ts:390`) plus a validation gate before the first
`update`.

## KTD6 — lifecycle states and fallback reasons

Map onto `research-publication-state-semantics.md` (already fanned
out): current / rebuilding / fallback vocabulary, enumerated reasons,
`known-incorrect` cleared only by rebuild. (The `view-version-expired`
reason and generation-bound invalidation above track uncommitted
upstream working-tree WIP, like the `read_many` change in KTD7 — not
yet in committed `36f8bfa51`.) Skip paths involved:
`closeResourceInstance` (`core:699-707`), `unsubscribe` (`:757-765`),
`close` (`:818-829`).

## KTD7 — view-backed reads (serialized `read_many`)

Tracks upstream working-tree WIP (uncommitted at time of writing):
the host exposes `read_many(rooms, minVersion)`, serialized with
`apply` on one per-generation queue. One queue turn returns every
requested room plus the generation's actual applied timestamp, and
that captured `view_ts` becomes the Transition's `new_ts` — ordinary
queries in the same query set run natively `At(new_ts)` and cannot mix
with accelerated rows from another version. If `view_ts` is no longer
readable by Convex, the whole update falls back natively with reason
`view-version-expired`. Subscriptions are generation-bound: a
generation change or lifecycle exit from Serving invalidates them, and
`extend_validity` additionally requires no feed change for the room in
`(view_ts, new_ts]`.

Build it on the ephemeral read paths: `getAll` (`core:633-658`) and
`getArray` (`:667-693`) instantiate → read → `closeResourceInstance`,
and `subscribe` (`:719-751`) with notifier marshaling (`:1298-1333`,
`{values,watermark,isInitial}`). The per-room feed-change signal is a
subscription on the room resource instance — exact invalidation, no
synthesized read set. Lazy vs eager placement for the feed follows
`core/src/api.ts:133,166,256,625` (`LazyCollection` memoized
on-demand, `EagerCollection` kept up-to-date, `mapReduce` fusing to
avoid intermediates).

Open race (correctness gap for KTD7/U1): `getAll`/`getArray` close
the instance in `finally`, and `subscribe` requires an already
instantiated instance id — no primitive reads a snapshot *and* arms
its invalidation signal atomically, so a notification can fall
between the snapshot read and the subscribe call. The plan must
require a serialized sequence that creates/subscribes the room
resource *before* exposing its first snapshot, tags notifications
with the host's applied version, and tests updates at every boundary
of that sequence (before-create, between create and subscribe,
between subscribe and first snapshot, after).

Resource lifecycle (scaling hazard): U1 creates and subscribes one
room resource per first read, but nothing bounds live resources —
a 10,000-room scaling run would measure leaked instances instead of
retained graph state. Require a host-owned resource registry with
generation-scoped cleanup (every instance closed on generation
reset), a maximum-live-resources bound, and resource-count/RSS
assertions alongside the entry-count/RSS status the plan already
requires.

## KTD8 — logical-work counters

Decision: the mechanisms counters wrap are real and located.
`core/src/api.ts:81-102` — `Reducer.remove` may return `null` to force
recompute via `initial`+`add`, with the add/remove round-trip invariant
stated. `skiplang/core/src/BaseTypes.sk:23` — `Reducer.update` tries
the remove-loop then the add-loop, `None` on any `remove=None`.
`prelude/src/skstore/EagerDir.sk:1717-1791` — `writeEntry`
short-circuits on `native_eq` (`:1727`, no dirty/reducer work),
runs `reducer.update` (`:1778`, `None` → `reducer.init` full
recompute), marks dirty only after confirmed change (`:1791`).
Memoization keys mappers/reducers by name for stage attribution
(`Runtime.sk:580,597,731`). So mapper-calls-per-stage, add/remove/
recompute counts, and feed-keys-changed all have observable hooks;
RSS/entry counts ride the `status`/`apply` responses.

Validation: pure add/remove/inverse unit tests with no runtime —
`examples/convex_reactive/skip/service.test.ts:1-74` (plus the
`convex_tanstack` twin) — prove reducer correctness before any Rust
exists, exactly U1's test-first order. The `Notifier` helper plus
`initTests` suite (`tests/src/tests.ts:64-148,1291-2379`) is the
integration-harness shape.

## KTD9/KTD10 — verification without fixtures

Constraint noted, not validated here: fixtures are gone upstream, so
Rust units stay on pure logic and end-to-end runs go through admin
endpoints. U7 comprises both: the JS-harness client shape it mirrors
is `helpers/src/remote.ts` (`SkipExternalService`: control mint →
SSE `init`/`update`) over `server/src/rest.ts:11-165`, and the corpus
it vendors is V1-V6 (see U1/U7/U8 section); the corrupt-row self-test
mirrors the seeded-mismatch proof pattern
(`shared-prereqs-q-self-test-seeded-mismatches`).

## U1/U7/U8 file layout to copy

Service-file trio present in both convex examples:
`skip/service.ts` (graph) + `skip/server.ts` (entrypoint) +
`skip/service.test.ts` (pure reducer/mapper units) — see
`examples/convex_reactive/` and `examples/convex_tanstack/`.
U1's test-first order (V1-V6 corpus semantics before Rust) maps to
`service.test.ts` now, `initTests` later. U7's corpus
(`convex-backend:research/.../semantic-vectors-v1.md`, V1-V6) maps to
our fanned-out vectors in `research-shared-PQ-skip-shape.md`. U8's
report maps to `shared-prereqs-q-report-format` (JSONL per
`data-sync-push-ktd-diagnostic-jsonl-schema`, update-only deltas,
seed/rebuild costs separated, classification rule stated, all-fallback
runs marked failed).

## Sources

- `convex-backend/docs/plans/2026-09-10-1702-feat-skip-incremental-materialized-cache-spike-plan.md`
  (`36f8bfa51`, KTD1-KTD10, U1-U8)
- `convex-backend/docs/plans/IDENTIFIER-MAP.md`
  (`incremental-materialized-cache-*`, `shared-prereqs-p-*`,
  `shared-prereqs-q-*`, `data-sync-push-*`)
- `convex-backend/research/skip-convex-integration/research-atomic-source-batch.md`
  (ordering/versioning/tombstones/replay/publication contract)
- `docs/research/research-skip-atomic-write-gap.md` (this directory;
  single-collection ceiling, merged-domain precedent)
- `convex-backend/research/skip-convex-integration/research-publication-state-semantics.md`
  (shared lifecycle vocabulary)
- `docs/research/research-shared-PQ-skip-shape.md` (this directory;
  fanned-out vectors, report schema)
- `convex-backend/research/skip-convex-integration/semantic-vectors-v1.md`
  (V1-V6 corpus)
- `docs/research/research-dir2-host-requirements.md` (this directory)
