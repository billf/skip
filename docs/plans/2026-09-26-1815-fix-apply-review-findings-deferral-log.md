# Review-findings deferral log

Tracked record of every synthesis-review finding deliberately deferred or
rejected rather than fixed, per the apply plan's Definition of Done. Each
entry names the disposition and the reason; anything not listed here was
fixed in its unit's `fixup!` commit (or the shared cleanup commit) and
proven by that unit's gate.

## Deferred (need future conditions)

- **U3 blocked live-runtime scenario** — the disclosed sixth scenario
  (same-tick membership+like update through a live Skip service) is
  still blocked on the Skiplang/WASM toolchain. Revisit when the
  toolchain is available; the commit message owns this disclosure.
- **U6/G unused `@skipruntime/core` dependency** — kept deliberately;
  later harness units may import it, and removal risks breaking them.
  Revisit once the harness surface stabilizes.
- **U9/F6+F7 design notes for U11** — `.passed` liveness semantics and
  watched-key deletion handling are open product questions for the U11
  live wiring, not defects in U9. Single-transition use is now
  documented on the class; the deeper questions go to U11's scope.
- **U10 server/package.json glob** — the same unquoted-`**` shape exists
  pre-existing in `skipruntime-ts/server/package.json:12` (verified
  empirically: works today by accident). Out of this stack's unit
  scope; fix with that package's own change.
- **U13/#7 typed closed-generation ApplyResult** — explicitly out of
  scope per U13's own docstring (assigned to the consuming spike);
  documented try/catch contract stands.
- **U14/u14-3 soft-limit provenance** — `DATA_SYNC_SOFT_LIMITS` values
  marked PROVISIONAL in code; verify against the Data Sync source
  before live wiring (1c's U6).
- **U8/F3 test-source caveat** — the non-empty parity cross-check pins
  the *observed* golden mapping (fixture rows reconstructed
  empirically); it does not copy the tutorial's `fixture.ts` source,
  which is not vendored anywhere in this repo.

## Rejected with evidence (no action, by design)

- **U2/F7 commit-message test count** — confirmed consistent, not wrong.
- **U6/F doc-only deepEqual note** — flat FeedRow shape needs nothing.
- **U6/L test-comment nit, U6/M positional cascade** — imprecise
  phrasing only; cascade fails safe by design.
- **U7/M6 historical test-count message** — awareness only.
- **U9/F3+F4 nits** (`Object.is`, `===` key comparison) — low
  confidence, out of scope for string-keyed harness domain.
- **U12/#5-vs-U9/F2 original shape** — resolved instead via the shared
  `deep_equal.ts` helper (cleanup commit on this branch).
- **U13/#12 watermark-persistence claim** — refuted on its evidence;
  folded into finding #1.
- **U14/u14-1 tombstone-GC coverage** — resolved by U13's fixup
  (delete→sweep→older-replay regression test), not by U14 action.
- **U16/#7 vocabulary scope** — refuted; the doc already scopes it.

## Fixed elsewhere (cross-unit, for traceability)

- **U9/F2 + U12/#5 deepEqual dedup** — one shared `deep_equal.ts`
  helper with pinned semantics test; all three call sites migrated
  (cleanup commit, not a unit fixup).
- **U12/#7 catalog generation claim** — corrected to hand-maintained
  (same cleanup commit).
- **Stale `2026-09-11` plan-path cites** — swept repo-wide across unit
  fixups and the cleanup commit; verified zero remaining in `src/`.
