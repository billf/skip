# @skip-adapter/atomic-batch

Provisional helpers for writing an atomic multi-table (or multi-query,
multi-page-region) update to a Skip `ExternalService` in one call, plus the
language-neutral `AtomicSourceBatch` contract those helpers implement. See
[SPEC.md](./SPEC.md) for the contract itself.

**No Skip runtime or FFI change.** `CollectionWriter.update` /
`ServiceInstance.update` already accept one batch of entries per call
(`skipruntime-ts/core/src/index.ts:476-501,768-782`); there is no
`updateMany`, and none is needed. This package is a convention plus a small
library on top of the existing single-call primitive: it never proposes or
requires a new Skip API. See `research-skip-atomic-write.md` in
`convex-backend` for the exhaustive grep confirming `updateMany`'s absence
through the CHANGELOG to v0.0.19; a broader batch-primitive generalization
remains a possible *future* contribution, out of scope here.

## Standalone value

This package is useful to any external Skip source that must publish a
group of changes — spanning several logical tables, several query IDs, or
several page regions — without a subscriber ever observing a partial group.
That correctness property ("no torn state") is independent of Convex,
Skip's own `@skip-adapter/convex`, or any of the spike integrations that
currently consume it.

## Status

**Provisional.** This package stays labeled provisional until a real
consumer (a shipped spike, or an external contribution upstream) validates
it in production use, per the shared plan's Success Criteria.

## Reviewing this package

A reviewer can approve this package without reading any consuming spike's
code. The review surface is:

- This README (no-runtime-change claim, standalone value, provisional
  label).
- [SPEC.md](./SPEC.md) (the `AtomicSourceBatch` contract, both encodings,
  the torn-state invariant, and scope).
- `src/index.ts` and its sibling modules (the exported types and helpers).
- The test suite (`src/*.test.ts`). At this scaffold stage it covers the
  dependency-surface boundary and the version/`package.json` sync; snapshot
  reconciliation, split/merge/order, and the revision-delta extension are
  planned for later units and will land entirely against synthetic data,
  with no dependency on Q or any spike.

## Installation

Within this workspace: `npm install` at the repo root links this package to
its sibling workspaces automatically.
