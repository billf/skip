# AtomicSourceBatch — specification

Status: **provisional**. Governs P1-P9 of
`convex-backend: docs/plans/2026-09-11-1159-feat-skip-shared-prerequisites-plan.md`.

`AtomicSourceBatch` is a language-neutral contract for publishing a group of
source changes to Skip so that no subscriber ever observes a partial
("torn") group. It names, per direction, that direction's source-order
version and its named consistency group, plus the ordering, delete form,
and replay behavior for the group's contents. It is specified once and
implemented twice: as external TypeScript helpers in this package
(`SnapshotBatch` consumers), and, for `RevisionDeltaBatch` consumers whose
implementation is backend-native, as prose any language can implement
against (Direction 2).

## The torn-state invariant

**A consistency group is published exactly once, in full, with no
subscriber-visible intermediate state.** Concretely: every entry belonging
to one source-order version's consistency group reaches Skip through a
single `writer.update(entries, isInit)` call (or, for a backend-native
implementation, the equivalent one atomic step). A consumer must never
issue N independent per-table (or per-query, or per-region) calls for data
that has to appear atomically — doing so lets a subscriber observe a state
where some but not all of the group's tables have updated.

This invariant is established, by this specification, only at the source
input: one write call is atomic from Skip's perspective. Whether that
atomicity survives a chain of downstream mappers, joins, filters, and
reducers to a derived feed is a separate, stronger claim that this package
does not itself prove — the shared plan's Q14 no-torn observer is what
establishes it, end to end, for a concrete consumer graph (AE13). Treat
"the batch was atomic" and "the derived feed showed no torn state" as
different claims until Q14 has actually observed the latter.

## Per-direction mapping

| Direction | Source-order version | Named consistency group |
|---|---|---|
| 1a | `Transition.end_version.ts` | The reassembled `Transition` |
| 1b | Page-set version | Incoming `Transition` transport group, and separately, the page-region-swap publication group |
| 1c | Revision `ts` / `snapshotTs` / cursor | The exact-`ts` group |
| Direction 2 | Commit version and causal watermark | The committed transaction |

1b's two groups are distinct and must not be conflated: a `Transition`
transport group and a page-region-swap publication group answer different
questions (what arrived together vs. what must appear together) and can
have different boundaries.

## Two non-interchangeable encodings

`AtomicSourceBatch` has exactly two encodings. A consumer picks the one its
direction requires; the two are never mixed within one batch.

### `SnapshotBatch` (1a, 1b only)

- Keyed by query ID (1a) or page-region ID (1b).
- Each key's value is that key's **complete current result array** — the
  bridge computes no row diff.
- An unchanged query or region is left untouched (omitted from the batch).
- Deletion is an empty value for a removed query, or a replacement value
  for a swapped region.
- Downstream split mappers project the per-key arrays into per-table rows
  so Skip derives row additions and removals itself.
- `isInit: true` is legal only when every live key is present in the same
  call (a cold start or fresh-reconnect snapshot); a partial `isInit: true`
  is a mass-delete hazard and is rejected.

### `RevisionDeltaBatch` (1c, Direction 2 only)

- Carries per-row revisions plus `_id`-only tombstones (`[key, []]`),
  derived from the retained value, never invented independently.
- In-value revision-watermark idempotency: a consumer applies an entry iff
  `entry.ts > retained_ts`. This is never Skip's own subscription/session
  tick — reusing that tick for idempotency is a spec violation.
- Cursors/watermarks advance only after the entire consistency group
  succeeds; a tombstone cannot be resurrected by a later replay of the same
  or an older group.
- Generation-fencing, replay-ledger, and tombstone/GC rules are specified
  separately in the revision-delta extension (P4, P5, P9); this baseline
  section only fixes the wire shape and the idempotency rule.
- **Live delivery and replacement (added 2026-10-01 for 1c's U4).** The
  lifecycle has exactly one write target at a time: a candidate, if one
  is being staged, and otherwise the live (promoted) generation. Writes for
  any other generation are dropped and counted as late.
  - **Live groups.** Once a generation is live, each consistency group is
    published as one `writer.update(..., false)` call. The group's
    watermarks and live rows commit only after that call resolves, so a
    rejected update leaves nothing behind and re-applies on retry.
  - **Promotion.** A candidate promotes with one `writer.update(entries,
    true)` call that carries its whole state. Tombstoned keys are not part
    of a published snapshot.
  - **Replacement.** A truncate while a generation is live starts a
    replacement candidate. It clones the live state, rows and watermarks,
    minus the truncated tables. Last-good stays published, marked stale by
    the consumer, until the candidate promotes. A further truncate clears
    only that table in the existing candidate. A truncated table's
    watermarks are forgotten, so its re-synced rows apply even at their old
    timestamps.

## Source-only scope (P3)

This specification, and this package's helpers, govern **only the source
side** of the write: how an external source calls into Skip so that one
consistency group becomes one atomic publication. It says nothing about,
and does not constrain:

- A direction's transport (HTTP/SSE, a native binding, a message queue).
- A direction's internal source topology upstream of the write call.
- Direction 2's native publication mechanism, which is out of reach for
  this package's TypeScript helpers by construction (backend-owned, no
  external-source boundary) and is covered only by the mapping table and
  invariant above, which any language can implement against.

Nothing here requires a Skip runtime or FFI change (P8): every rule above
is satisfiable with the existing single-call `writer.update` /
`ServiceInstance.update` primitive.
