# skip-convex-proof-harness

A correctness-comparator and fault-injection harness for the shared
Skip/Convex proof vehicle defined in
`docs/plans/2026-09-14-skip-shared-prerequisites-plan.md`
(this plan's "Q" sub-deliverable). It builds no spike itself and ships
its own tests against synthetic and vendored corpus data, with no
dependency on any consuming spike's code (1a, 1b, 1c, or Direction 2).

**Provisional.** `schema/report.schema.json` and
`schema/mismatch.schema.json` are candidates for the interface
Direction 2's review entry asks for -- not a claimed shared interface.
Nothing here is load-bearing for any spike's own review until that
spike names this package as a dependency.

## What's here

- `catalog.ts` -- Q11's metric catalog (one typed record naming every
  counter/timer, its unit, and its required/optional/not-applicable
  status per direction), transcribed from
  `research-spike-comparison.md` / `research-core-metric-profile.md`.
- `readiness.ts` -- Q1's readiness detector: gates one (source group
  applied) and two (derived result published), under the quiesced and
  revision-tagged disciplines. Never reads the native oracle.
- `checkpoint.ts` -- the checkpoint emitter every source calls per
  transition so a step with no output change still settles.
- `recorder.ts` -- Q5's recorder: validates every metric against the
  catalog, records the freshness disposition (gate four), and writes
  JSONL.
- `sse_reader.ts` -- the Skip-side reader (KTD7): parses `init`/
  `update`/heartbeat/`checkpoint` SSE framing, loopback-only, fail-
  closed on malformed known events.
- `native_reader.ts` -- Q2's admission rule for one native
  (`ConvexClient`) one-shot read against a target revision.
- `parity.ts` -- Q2's label-mapped parity function (a bit-for-bit port
  of convex-tutorial's `computeParity`), used to pre-check a
  deployment/convex-test pair before admitting convex-test as a
  reader.
- `observer.ts` -- Q14's no-torn observer (AE13): detects any published
  intermediate state of a named atomic group, in either write order.
- `faults/` -- Q6's snapshot-path baseline fault injectors and Q7's
  reusable detection/recovery/count assertions.
- `corpus.ts` / `comparator.ts` -- the vendored V1-V6 corpus (semantic-
  hash checked against convex-tutorial's canonical copy) and Q3's
  canonical deep-equal comparator.
- `schema/` -- JSON Schemas for the report (one JSONL line per
  checkpoint) and mismatch record shapes.

## Reviewing this package

A reviewer can approve this package without reading any spike's code.
The review surface is:

1. **The comparator** (`comparator.ts`): does `compareFeeds` correctly
   distinguish a swapped tie, a missing/extra row, a nullable-sender
   mismatch, and a bounded-prefix overrun -- positionally, never
   re-sorting either side?
2. **The fault injectors** (`faults/injector.ts`): does every baseline
   fault's expected state stay within
   not-yet-loaded/frozen/blank, never a partial published as current
   (`research-publication-state-semantics.md`'s invariant)?
3. **The seeded-mismatch tests**: `comparator.test.ts` and
   `schema_validate.test.ts` seed a deliberately wrong value (a wrong
   `likeCount`, a renamed metric field) and assert the comparator/
   schema actually catches it, rather than only exercising the
   matching path.

`npm test -w skip-convex-proof-harness` runs everything, including
`dependency-surface.test.ts`, which asserts this package imports no
spike package (AE8).
