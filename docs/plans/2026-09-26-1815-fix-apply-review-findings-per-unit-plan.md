---
title: Apply Review Findings Per Unit - Plan
type: fix
date: 2026-09-26
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Apply Review Findings Per Unit

## Goal Capsule

- **Objective:** Every finding in the twelve synthesis reviews is either fixed on its unit commit, explicitly deferred with a reason, or rejected with evidence, and the branch history reads as twelve clean unit commits on the shared-prerequisites stack.
- **Means:** Per-unit fixup passes on the branch tip with hybrid routing, folded by a final autosquash (KTD1).
- **Authority:** Session-settled routing decisions (KTD1, KTD2) override executor judgment on shape; synthesis review files own finding validity; this plan owns sequencing and gates.
- **Stop conditions:** Pause before plan unit U2 of this plan (user instruction); push only on explicit approval; surface any finding that contradicts its unit's design instead of guessing.
- **Who finishes:** The planning session pauses after the artifact; a build session (self plus one delegated Claude reviewer per complex unit) executes.

## Product Contract

### Summary

Twelve synthesis code reviews (one per stack unit U1, U2, U3, U6, U7, U8, U9, U10, U12, U13, U14, U16) sit in the ignored `.agent-reviews/` directory, each identified by frontmatter `unit` and `subject`. The recorded `full_sha` values are pre-restack originals and no longer exist on the branch, so live binding uses subject plus unit number with live-SHA re-resolution per R1 and KTD4. Stack U1 is fully applied and squashed. The remaining eleven units need their findings applied to the rewritten branch commits, oldest first, with narrow-trivial fixes done inline and complex fixes delegated to a Claude subagent returning a patch.

### Problem Frame

Reviews were written against pre-restack SHAs and the stack has since been rewritten twice, so SHAs recorded in review frontmatter no longer exist on the branch. Applying findings to the wrong commit, amending mid-sequence (which shifts every later SHA), or landing untested logic fixes under rebase pressure would corrupt the stack. The work needs a fixed join key, a no-SHA-shift application shape, and a per-unit proof gate.

### Requirements

- R1. Each synthesis file maps to exactly one live branch commit, confirmed by subject and unit number before any edit touches that unit.
- R2. Narrow-trivial findings (docs, comments, plan-path citations, message wording, test-only additions) are fixed inline without delegation.
- R3. Complex findings (behavioral, logic, contract, or test-design changes) are fixed from a delegated patch scoped to the single synthesis file and the single target commit diff.
- R4. No unit is declared done while its touched workspace typecheck or tests fail, or while the tree holds unrelated changes.
- R5. The finished history contains the twelve unit commits with fixes folded in, and no leftover fixup or scratch commits.
- R6. Review outputs stay in the ignored `.agent-reviews/` directory; the only tracked additions are the plan artifact itself, the intended code fixes, and one tracked deferral log listing every deferred or rejected finding with its reason.

### Scope Boundaries

- In scope: the eleven remaining synthesis files and their eleven unit commits (stack U2, stack U3, stack U6, stack U7, stack U8, stack U9, stack U10, stack U12, stack U13, stack U14, stack U16).
- Out of scope: the `plan: convex restack` commit, upstream history, the six stray concurrent review files, and any finding the unit owner rejects with evidence (recorded, not applied).
- Deferred to follow-up work: review U3 findings that depend on the blocked live-runtime scenario; any finding that contradicts its unit's settled design (surfaced, not guessed).

## Planning Contract

- KTD1. Hybrid apply shape: `fixup!` commits per unit on the tip, one final autosquash (session-settled: user-directed — chosen over pure amend-in-place and pure fixup chains: avoids SHA-shift during application while ending with clean history).
- KTD2. Narrow trivial line: only docs, comments, plan-path citations, message wording, and test-only additions go inline (session-settled: user-directed — chosen over the broad line that admitted small logic changes: keeps behavioral edits under delegated review).
- KTD3. Linear oldest-first order with per-unit gates, strictly sequential across units (a later unit's base shifts with every earlier fold, so parallel application would race; parallelism lives inside a unit only).
- KTD4. Join key is unit subject plus live-SHA re-resolution at execution time, never the recorded `full_sha` (the recorded SHAs are pre-restack originals and no longer on the branch).
- KTD5. Delegated patches return patch-only and never commit (keeps authorship and sequencing with the orchestrator).

### Assumptions

- The synthesis files are valid and complete; their P1/P2 findings are actionable as stated.
- The branch tip at execution still contains the twelve unit subjects in order; any new restack re-triggers KTD4 re-resolution.
- The delegated reviewer has commit-pinned read access to the synthesis file and the target diff.

### Sequencing

Preamble (done): U1 fixup squashed into rewritten U1. Then plan units U1–U4 below in order. Pause before plan U2 per user instruction; the read-only mapping in plan U1 may proceed once this plan is approved.

---

## Implementation Units

Naming convention: headings below (`U1`–`U4`) are plan steps. Stack commits and synthesis reviews are always written `stack U<N>` or `review U<N>` in body text, never bare, so the two namespaces cannot be confused.

### U1. Bind each synthesis file to its live commit

- **Goal:** A verified unit-to-SHA table for the eleven remaining units, with zero ambiguity before any edit.
- **Requirements:** Covers R1.
- **Dependencies:** None.
- **Files:** `.agent-reviews/u*.md` (read-only inputs; never edited or tracked).
- **Approach:** List the branch commits above the shared base and match each by unit subject and number against review frontmatter (`unit`, `subject`). Record full live SHAs in the session. Abort the whole run on any mismatch rather than applying to the wrong commit.
- **Test scenarios:**
  - Every synthesis file has exactly one live commit and vice versa; gaps at stack U4/U5/U11/U15 correctly have neither (those units never existed).
  - Recorded `full_sha` values are confirmed absent-or-superseded, never mistaken for live targets.
- **Verification:** A posted table of eleven pairs with no unmatched rows on either side.

### U2. Apply batch A (review U2, U3, U6, U7)

- **Goal:** All actionable findings of the four earliest synthesis reviews fixed on their unit commits.
- **Requirements:** Covers R2, R3, R4.
- **Dependencies:** Plan U1.
- **Files:** `skipruntime-ts/adapters/atomic-batch/src/snapshot.ts`, `skipruntime-ts/adapters/atomic-batch/src/keys.ts`, `skipruntime-ts/adapters/atomic-batch/src/split.ts`, `skipruntime-ts/adapters/atomic-batch/src/room_feed.ts`, `skipruntime-ts/adapters/atomic-batch/src/index.ts`, `examples/convex_proof_harness/src/comparator.ts`, `examples/convex_proof_harness/src/corpus.ts`, `examples/convex_proof_harness/src/readiness.ts`, `examples/convex_proof_harness/src/checkpoint.ts`, `examples/convex_proof_harness/src/catalog.ts`, `examples/convex_proof_harness/src/recorder.ts`, plus their colocated tests.
- **Approach:** Per unit oldest-first: fix narrow-trivial inline per KTD2; delegate complex findings to one Claude subagent scoped to that unit's synthesis file and diff, patch-only return. Land each unit's work as one `fixup!` commit. Review U3 runtime-dependent findings defer with a recorded reason instead of forcing.
- **Execution note:** Prefer runtime proof over unit coverage where the harness exercises live behavior.
- **Test scenarios:**
  - Atomic-batch workspace typecheck plus unit tests pass after each unit's fixup.
  - Proof-harness tests pass after the stack U6 fixup.
  - A delegated patch that fails its unit gate is reworked at the same stop, never carried forward broken.
- **Verification:** Three-to-four fixup commits, each touching only its unit's files, typecheck and tests green per fixup, tree clean after each. A unit whose findings are all deferred or rejected lands no fixup, only a recorded deferral note standing in for it.

### U3. Apply batch B (review U8, U9, U10, U12) and batch C (review U13, U14, U16)

- **Goal:** All actionable findings of the remaining seven synthesis reviews fixed on their unit commits.
- **Requirements:** Covers R2, R3, R4.
- **Dependencies:** Plan U2.
- **Files:** The SSE reader, parity, observer, injector, schema, revision-delta, generation, and methodology sources named by each unit diff, plus their colocated tests.
- **Approach:** Same per-unit shape as plan U2. U13 generation-promotion and group-retry findings get delegated review even where the diff looks small, since retry and fencing semantics are behavioral. Delegates for stack U13/U14 each receive both units' synthesis files, since fencing and watermark invariants span the pair. U16 methodology findings stay prose-scoped unless a cited schema must change with them.
- **Test scenarios:**
  - Touched workspace tests pass after each unit's fixup, including the revision-delta suites for U13/U14.
  - Schema changes in stack U12/U16 keep their pinned version assertions green.
- **Verification:** Seven fixup commits, each scoped to its unit, typecheck and tests green per fixup, tree clean after each. A unit whose findings are all deferred or rejected lands no fixup, only a recorded deferral note.

### U4. Fold fixups and prove the stack

- **Goal:** The finished history reads as twelve clean unit commits with all fixes folded in and fully proven.
- **Requirements:** Covers R5, R6.
- **Dependencies:** Plan U3.
- **Files:** No source files; history operation plus verification runs.
- **Approach:** Before folding, run the full affected-workspace verification once on the unfolded tip with all fixups applied, so cross-unit invariant breaks surface while each fix is still attributable to its unit. Then one autosquash pass over the shared base folds every `fixup!` into its unit, followed by a final full verification on the folded tree. Every deferred or rejected finding is recorded with its reason in the tracked deferral log at `docs/plans/2026-09-26-1815-fix-apply-review-findings-deferral-log.md`. Any conflict or failure stops at that unit for rework, never skipped blindly.
- **Test scenarios:**
  - Pre-fold full verification passes on the unfolded tip with all fixups applied.
  - Post-fold log shows the twelve unit subjects in order with no fixup or scratch commits remaining.
  - Full affected-workspace tests and typechecks pass on the folded tip.
  - Tracked status shows only intended code changes plus this plan artifact.
- **Verification:** Clean log, green verification at both gates, deferral log committed, and no push; await explicit approval.

---

## Verification Contract

| Gate | Applies to | Done signal |
|---|---|---|
| Unit mapping table complete with no unmatched rows | Plan U1 | Posted table, zero ambiguity |
| Touched workspace typecheck and unit tests pass per fixup | Plan U2, U3 | Green run after each unit, tree clean |
| Autosquash log shows twelve units, no fixups | Plan U4 | Log order matches stack order |
| Full verification green on unfolded tip | Plan U4 | Green pre-fold run, breaks attributable per unit |
| Full verification green on folded tip | Plan U4 | Green run, clean status, no push without approval |

## Definition of Done

- Every synthesis finding is fixed, deferred with a reason, or rejected with evidence; no finding is silently dropped, and every deferral or rejection is listed in the tracked deferral log.
- History holds twelve unit commits with fixes folded in and no fixup or scratch commits.
- Verification Contract gates are all green and the tree holds only intended changes.
- Push happens only on explicit user approval.

## Risks & Dependencies

- Restack drift: any new rewrite invalidates recorded SHAs mid-run; KTD4 re-resolution is the mitigation, and a mismatch aborts the unit.
- Delegated patch quality: complex findings arrive as uncommitted patches so the orchestrator inspects them against the unit gate before landing.
- Review U3 blocked scenario: forcing runtime-dependent fixes without the live service risks invented behavior; deferral is the correct outcome there.

## Appendix

- Review corpus: `.agent-reviews/u*_20260926-210901_*.md` (twelve synthesis files, ignored, untracked).
- Prior per-round reviews and run timestamps are recorded in each synthesis file's `sources` frontmatter.
- Preamble evidence: stack U1 fixup `d1b07dc4` folded into rewritten stack U1 `43a8337c`, verified by stat showing the hardened guard tests and `version.test.ts` present.
- Cross-model peer disclosure from the review phase carries into delegation prompts, which contain only the synthesis report and the target diff.
