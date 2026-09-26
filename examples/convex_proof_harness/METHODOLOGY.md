# Q12: logical-checkpoint methodology

Language-neutral specification of "when may equality be claimed"
between a Skip-derived result and its native oracle. It exists so
Direction 2 (and any other native, non-TypeScript comparator) can
implement an equivalent comparator without importing this package's
code -- Q12 is a specification-only dependency, outside the snapshot-
baseline gate that P and Q's TypeScript implementation sits behind.

This document states the shared definition; it does not restate the
reasoning behind it. For per-direction rationale and the "why," see
`docs/plans/2026-09-14-skip-shared-prerequisites-plan.md` (the Q12/Q14
plan: gates, vocabulary, N/K/F axes, normalization) and this package's
own `src/catalog.ts` (the Q11 metric-name authority). This package's own
`schema/report.schema.json` and `schema/mismatch.schema.json`
(`schemaVersion: "1.0.0"`, U12) are the machine-checkable twin of the
report/mismatch shapes this document describes in prose.

## The four gates

Equality may be claimed only once all four gates pass, in this order.
Gates 1-2 are runtime states that must hold during normal serving with
no benchmarking machinery present; gates 3-4 exist only for the
harness. Serving never depends on the comparator; the comparator never
redefines serving states.

1. **Source batch applied.** The direction's indivisible source unit
   (a `Transition`, a page-group swap, a timestamp group, a commit
   version -- see the shared `AtomicSourceBatch` contract) is fully
   ingested.
2. **Derived result published.** The Skip view/projection for that
   unit is published under the publication-state rules below, never
   as a partial result presented as current.
3. **Native oracle observed** (harness only). The independent native
   result for the same logical version is available.
4. **Freshness state recorded** (harness only, owned by the
   recorder). The checkpoint's freshness disposition -- `current`,
   `stale-with-reason`, or `fallback-with-reason` -- is written by the
   recorder, never inferred from silence and never by the readiness
   detector (the detector decides *settled*; the recorder decides and
   records *fresh*). An equality claim requires `current` specifically;
   see `comparison-ready` below -- a `stale-with-reason` or
   `fallback-with-reason` checkpoint never supports one on its own.

Gates 1-2 are a runnable predicate (a required-version marker: a
`Transition`'s end version, a Data-Sync `UpToDate(ts)`, or an
equivalent), under either of two disciplines a caller chooses per run:
writes quiesced until both readers settle, or writes tagged with a
workload revision so both readers are compared at the same revision.
Both disciplines are implemented once, shared by every direction; no
consumer builds its own tagging scheme.

## `current` vs `comparison-ready`

`current` is a **runtime** publication state: it must hold during
ordinary serving, with no harness present. `comparison-ready` is
**harness-only**: `current` plus all four gates above, including the
independent native oracle. A direction's serving code is never
comparator-aware; the comparator is a wrapper that observes it.

## Publication-state vocabulary

A shared vocabulary standardizes state *names*, not implementations.
The one invariant every direction's fault behavior must uphold: **never
publish a partial result as current.**

| Shared state | Meaning | Never |
|---|---|---|
| `not-yet-loaded` | No prior good result exists yet; nothing to freeze. | Published as `blank`-and-current. |
| `frozen` | A prior good result is held while a rebuild/reconnect/resnapshot is in flight. | Published as `current` mid-rebuild. |
| `blank` | An intentional removal/unsubscribe emptied the result. | Confused with a failure (see `terminal`). |
| `current` | Settled, gates 1-2 pass; safe to serve. | Partial. |
| `comparison-ready` | Harness-only: `current` plus gates 3-4. | Claimed by serving code. |
| `removed` | The result was intentionally deleted/truncated, not lost. | Treated as a fault. |
| `terminal` | A distinct, unrecoverable failure state. | Conflated with `frozen`. |

## Normalization rules

Before comparing two feeds, both sides are normalized the same way:

- **Anchor** on the required-version marker (gates 1-2), never on
  wall-clock time.
- **Sort explicitly**: the canonical order is descending
  `(_creationTime, _id)`; a Skip-side key-encoding trick and a
  native-side explicit sort must each independently reach that same
  order -- never trust one side's at-rest order to already match.
  (Sort ownership sits with the callers: `comparator.ts` compares
  positionally and never re-sorts either side itself.)
- **Nullable-sender parity**: a missing user resolves to `null` on
  both sides; a placeholder string (e.g. `"Unknown"`) is a mismatch,
  not an equivalent encoding.
- **Exact `likeCount` comparison**: no tolerance band.
- **Bounded prefix (`take(50)`) on both query sides**: the
  Skip/derived side takes the top 50 and the native oracle issues the
  same bounded top-50 query (per Q13's fixture) -- never an unbounded
  read on either side, and never a bound pushed into the
  source-of-truth take, which a downstream diff would read as mass
  deletion.
- **Assert disjoint `_id` sets**: never silently dedup a repeated id;
  a repeat is a mismatch to surface, not absorb.
- **Stable keys**: a regenerated (non-stable) key defeats any
  native-equality check that keys off it.

## Per-direction bindings

| Direction | Checkpoint vocabulary | Notes |
|---|---|---|
| 1a | Writes settled, before the next write begins. | Excludes the failure checkpoint itself; freeze is verified as a state, not as an equality claim. |
| 1b | Writes quiesced **or** tagged by workload revision; both paths reach the same revision. | Revision-tagging preferred where quiescence is flaky. |
| 1c | Cursor-after-all-groups plus watermarks; a failure never advances the watermark. | Logical (`Timestamp`) vs wall-clock separation is required in every timer. |
| D2 | View at or past the connection's causal sync watermark (max commit version observed). | A cancelled/deadline-exceeded read is counted as a fallback, never compared. |

Q1's readiness detector is the one runnable form of gates 1-2 across
all four bindings; Q3's comparator supplies gate-3 normalization; the
Q5 recorder owns gate-4 recording. No direction reimplements any of
the three.

## N/K/F axes

Every direction reports its scaling claim in the same three axes so
results are comparable without conflating non-equivalent units:

- **`N`**: total scope the monolithic baseline re-touches (selected
  documents, loaded rows, an unrelated dataset). Always reported
  alongside any steady-state win, as `O(N)` bootstrap/retained cost.
- **`K`**: change size per transaction (selected revisions,
  affected-page length observed -- never assumed from a page-size
  constant, changed rows in the dependency neighborhood).
- **`F`**: derived fan-out of `K` (a join's width: user to messages,
  message to likes, a membership filter). Derived update cost is
  `O(K+F)`.

Same-slot metrics that are **not** equivalent efficiency units --
e.g. one direction's delivered snapshot rows vs another's emitted
revisions -- are reported side by side, direction-tagged, and never
reduced to a single cross-direction ratio; each direction is compared
only against its own monolithic baseline.

Concrete counter names and units are `src/catalog.ts`'s Q11 catalog,
not this document: `sourceRowsBytes` (rows|bytes), `atomicBatches`
(batches), `changedKeys` (keys), `dependentWork` (nodes),
`reducerWork` (ops), `staleDuration` (ms), `mismatch` (count),
`fallback` (count). `report.schema.json` intentionally does not
enumerate them; the catalog is the name authority.

## Q14: no-torn observation protocol

An atomic write's caller-named group is watched as a resource plus the
group's pre-state and post-state values on its watched keys:

1. **Record** every published state on those keys, keyed by its
   watermark.
2. **Flag** any published state equal to neither the pre-state nor the
   post-state as torn, regardless of which write order produced it.
3. **Refuse**, as a harness error rather than a silent pass, a group
   whose pre-state and post-state are equal, or whose single-field-
   first partial state (the intermediate either write order would
   produce) already equals the pre- or post-state -- such a group can
   never tell the two write orders apart, so it proves nothing either
   way.

## Versioning

This document and `schema/{report,mismatch}.schema.json` version
together. The schemas currently at `schemaVersion: "1.0.0"` are the
machine-checkable companion to the prose above; a future revision to
either is reflected in both, and any consumer (Direction 2's native
comparator, 1c's KTD10 JSONL) cites the schema version it was built
against.
