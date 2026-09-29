---
title: Convex stack restack into one-thesis local branches
type: plans-process
direction: cross-cutting
date: 2026-09-26
---

# Convex stack restack into one-thesis local branches

Restack the work in [billf/skip#1](https://github.com/billf/skip/pull/1), [billf/skip#2](https://github.com/billf/skip/pull/2), and the two later local adapter commits into fresh one-thesis local branches. Commit each replacement branch, including the generated-files attributes branch. Do not push these branches, create PRs for them, close the source PRs, or rewrite either published branch or the local adapter branch.

The source history changed after the original plan. On 2026-09-29, `origin/main` is `04052ca3`, `upstream/main` is `56e6a3be`, `origin/billf/convex/example` is `43734f62`, PR #2's `origin/billf/convex/adapter-2` is `0a450650`, and local `billf/convex/adapter` is `ac39e72c`. Before any splitting, re-resolve `origin/main`, `upstream/main`, both pushed PR heads, and local `billf/convex/adapter`; recompute the 12/15/2 counts and remap any new commits. Do not use the pinned SHAs above if any tip has moved.

PR #1 has 12 example commits. PR #2 reports 27 commits because it still contains 12 patch-equivalent copies of the example commits from before PR #1's rebase; its unique range after `c909d6c7` has 15 commits. The local adapter branch carries equivalent work on the rebased example plus two more documentation commits, `daf8d746` and `ac39e72c`. Carry the 12 example changes once, all 15 unique PR #2 changes, and both local additions. The tables below map every one of those 29 distinct commits to 23 replacement thesis branches, plus the generated-files branch: 24 branches in all. Review-round revisions and extraction follow-ups fold into their owning branches, so source commit count does not dictate branch count. The old four-commit adapter list is historical evidence, not the current replay list.

Edict: one thesis per local branch, normally one commit. Split work happens in an independent scratch clone rooted at fetched `origin/*` refs, with its own branch namespace and `origin` pointing to `billf/skip`. The existing adapter and `feat/skip-shared-prereqs` worktrees, including their uncommitted files, stay untouched.

## U1 — Bottom generated-files commit

New branch `billf/convex/generated-attributes` off `main`. Adds the
repo's first root `.gitattributes` (only `sql/server/.gitattributes`
for line endings exists today; `git check-attr` confirms all three
paths below are currently unspecified):

```gitattributes
package-lock.json linguist-generated=true
examples/*/convex/_generated/** linguist-generated=true
**/routeTree.gen.ts linguist-generated=true
```

The bare `package-lock.json` pattern matches at every level, covering
the root lockfile (present on `main`) and both example lockfiles. Commit this branch first, then build every replacement branch from its tip so they inherit collapsed generated diffs. Other worktrees (`sync-upstream`, `upstream`, `feat/skip-shared-prereqs`) are outside this restack and remain untouched. Verify with `git check-attr linguist-generated -- <paths>`.

## U2 — Scratch setup and safety

Fetch `origin`, inspect `upstream/main`, and record full SHAs and tree IDs for `origin/main`, both pushed PR heads, and local `billf/convex/adapter`. Save immutable backup refs for all three source branch tips. Create an independent scratch clone under `/tmp`, with `origin` set to `billf/skip`, and a disposable `restack-source-example` branch at the fetched example tip. Keep the published and local source branch names out of the scratch split.

The U3, U5, U7, and U8 tables below are the source ledger. Their suffixes expand to `billf/convex/restack/<suffix>` unless a full branch name is shown. Each row lists every destination for that commit; a slash-separated list means the commit is split by the path or hunk ownership specified below, while repeated suffixes mean later revisions fold into the same thesis. The PR #2 range from `origin/billf/convex/example` is misleading after the rebase; its 12 old example commits are patch-equivalent copies of U3 and have no separate destination. Use its 15 unique commits from `c909d6c7..0a450650` and apply the two local-only commits by patch. Compare source trees after resolving the two adapter lineages' base and lockfile differences.

## U3 — Map and split the example commits

Treat the 12 example patches as presumed unchanged by the rebase (a prior `git range-diff` matched them one for one). Before splitting, re-run `git range-diff` on the current tips; abort and remap the destination map if any pair does not match one-for-one, and do not discard the 12 old PR #2 copies until that check passes. Split only `restack-source-example` in the independent clone; `--branch` selects that disposable source explicitly. Every current example commit has a destination:

| Current example commit | Old PR #2 equivalent | Destination suffix | Thesis or split |
| --- | --- | --- | --- |
| `fd69abb9` | `b436ce57` | `example` | Reactive scaffold |
| `6d916d1f` | `ac10bab1` | `example-tanstack` | TanStack frontend |
| `292ae5df` | `6b962166` | `mirror-fix` | Mirror advance correctness |
| `6f77a894` | `425735eb` | `sync-guard` / `design-docs` | Service and projection guard, including TanStack transaction staging, versus control-API prose and Vite comments |
| `60e36495` | `e506bc66` | `adapter-seam` | Publishability seam and subscriber injection |
| `6ab431f7` | `c53910b6` | `design-docs` | DESIGN.md corrections |
| `59c2b839` | `6e049b12` | `design-docs` | Convex-rs verification in DESIGN.md |
| `f456bf61` | `a7d62750` | `adapter-contracts` / `stream-reconnect` | Adapter defects and tests versus both frontend stream-reconnect hunks |
| `6d0154ea` | `51b07061` | `adapter-lifecycle` | Subscription lifecycle hardening |
| `8a93616c` | `3011cf0d` | `adapter-lifecycle` | Bootstrap snapshot retry |
| `1fd645aa` | `43340dab` | `service-api-compat` | SkipService API compatibility |
| `43734f62` | `c909d6c7` | `adapter-parity` | TanStack adapter-copy parity |

Each `--at` below names the tip of an initial segment; U4 moves the mixed hunks to their listed destination branches. Create `stream-reconnect` immediately above `adapter-contracts` and below `adapter-lifecycle` when moving the two frontend reconnection hunks, so its absence from the initial split command is deliberate:

```bash
gs branch split --branch restack-source-example \
  --at fd69abb9:billf/convex/restack/example \
  --at 6d916d1f:billf/convex/restack/example-tanstack \
  --at 292ae5df:billf/convex/restack/mirror-fix \
  --at 6f77a894:billf/convex/restack/sync-guard \
  --at 60e36495:billf/convex/restack/adapter-seam \
  --at 59c2b839:billf/convex/restack/design-docs \
  --at f456bf61:billf/convex/restack/adapter-contracts \
  --at 8a93616c:billf/convex/restack/adapter-lifecycle \
  --at 1fd645aa:billf/convex/restack/service-api-compat \
  --at 43734f62:billf/convex/restack/adapter-parity
```

The split must place the final code and documentation on the named branches even if that changes commit SHAs or branch tips. Commits without their own `--at` entry fold into the enclosing segment: `6ab431f7` rides with the segment ending at `59c2b839` (`design-docs`), and `6d0154ea` rides with the segment ending at `8a93616c` (`adapter-lifecycle`).

Gate: exact multi-`--at` segment ownership is inferred from
`gs branch split --help` ("if the original branch is assigned to one
of the splits, a new name is required for HEAD"). Before the real split, prove segment ownership with a disposable dry-run, record the verified invocation, and adjust the map before final commits; if the inference is wrong, fall back to single-step splits or manual branch creation. Build or rebase the replacement code branches onto the committed attributes branch so every replacement branch inherits `.gitattributes`; verify ancestry before declaring the local stack complete. Keep all replacement branch names distinct from the two source PR heads.

## U4 — Hunk-split the mixed commits at branch tips

`gs commit split` only splits the current commit in place, so it cannot move hunks across branches. For each cross-branch move below, save the source hunks as a patch, amend the source tip to remove them, and restack descendants onto the amended source. Then create or edit the destination branch at its stated base, apply the saved patch there, amend its thesis commit (or create it if the branch is new), and restack its descendants so they inherit the change once. In `6f77a894`, keep `skip/service.ts`, its tests, and TanStack transaction staging in `sync-guard`; move DESIGN.md, README, and Vite control-API prose to `design-docs`. In `f456bf61`, keep adapter teardown and contract code/tests in `adapter-contracts`; move the reconnect logic in `examples/convex_reactive/src/skip_stream.ts` and `examples/convex_tanstack/src/skip_collection.ts` to `stream-reconnect`, preserving their shared behavior as one thesis. Keep its DESIGN.md contract note with `adapter-contracts`. Verify every moved hunk occurs exactly once in the final stack. For the giant adapter move, prefer path-based staging over interactive splitting through lockfile churn.

## U5 — Map and split the current adapter code commits

The local lineage has corresponding commits `454a200d`, `3b0a8bec`, and `b4338c95`; its extraction differs in generated lockfile context after rebasing. Use the pushed PR commits as the default content source and the local commits as a parity check. Before replay, diff each pushed/local pair excluding lockfiles; if non-lockfile differences exist, record which lineage is authoritative for each affected path in the ledger:

| Pushed commit | Local equivalent | Destination suffix | Thesis or split |
| --- | --- | --- | --- |
| `00ef7959` | `454a200d` | `adapter-extract` | Publishable shared package, workspace integration, and both example consumers as one atomic thesis |
| `011d8e2c` | `3b0a8bec` | `recovery-bounds` | Bounded subscription recovery and its tests/docs |
| `076bd463` | `b4338c95` | `adapter-extract` | Fold the example test-build prerequisite into the extraction's consumer setup |

The package, root workspace registration, example imports, publish wiring, and build-before-tests scripts form one usable extraction; splitting the new API from its only consumers would leave intermediate branches with a broken build. Fold `076bd463` and the production-plan status note from `80250107` into `adapter-extract`, retaining their source identities in the ledger. Keep `recovery-bounds` separate because it changes runtime retry behavior and has its own tests. Verify caller-owned client and bootstrap-retry behavior in the resulting adapter and examples. The old plan's `ownership` and `bootstrap-retry` SHAs are superseded and must not be blindly cherry-picked.

## U7 — Map the research and planning commits

The twelve pushed commits from `ffebc354` through `0a450650` are part of PR #2. They create or revise the same documents repeatedly. Apply the stack-rewriter principle here: preserve each material change, but fold review-round and follow-up edits into a single idiomatic commit on the branch that owns the final document. Do this only on fresh replacement branches; the pushed source history remains intact. Subjects describe the document's conclusion or engineering contract, not the review round.

Research has four branch theses. `research-adapter-boundary` owns `research-convex-adapter-v1.md`, `research-control-streaming-boundary.md`, and `research-skip-externals-contract.md`. `research-source-spikes` owns the 1a mapping, 1b page-region, and 1c push-contract notes as one comparative source-spike set. `research-shared-invariants` owns `research-shared-PQ-skip-shape.md` and `research-skip-atomic-write-gap.md`. `research-dir2-host` owns `research-dir2-host-requirements.md`, `research-postgres-reference.md`, and `research-dir2-skip-evidence.md`. All these paths are under `docs/research/`. The research README is an index, so fold it into the last research branch after the indexed documents are in its ancestry rather than create an index-only branch.

The four plan suffixes `plan-spikes`, `plan-shared-prereqs`, `plan-dir2-reference`, and `plan-dir2-cache` own, respectively, `docs/plans/2026-09-14-skip-spike-references-plan.md`, `2026-09-14-skip-shared-prerequisites-plan.md`, `2026-09-14-skip-dir2-reference-plan.md`, and `2026-09-14-skip-dir2-materialized-cache-plan.md`. `plan-shared-prereqs` also owns `docs/backlog.md`, which was split from that plan. The later `examples/convex_reactive/DESIGN.md` status update folds into `adapter-extract`.

| Pushed commit | Local equivalent | Destination suffixes | Allocation |
| --- | --- | --- | --- |
| `ffebc354` | `c860768f` | `research-adapter-boundary`, `research-source-spikes`, `research-shared-invariants`, `research-dir2-host` | Split its 11 added files by the path ownership above; the README lands with the last research branch |
| `80250107` | `bcc61eb5` | `adapter-extract` | Fold the extraction-complete status note into the adapter commit |
| `6e31f971` | `43c91359` | `plan-spikes`, `plan-shared-prereqs`, `plan-dir2-reference`, `plan-dir2-cache` | One new plan file per branch |
| `ca40e1e5` | `be44c65a` | `plan-spikes`, `plan-shared-prereqs`, `plan-dir2-reference`, `plan-dir2-cache`, `research-source-spikes`, `research-dir2-host`, `research-shared-invariants` | Fold anchor corrections into each touched file's owner |
| `4693bfa2` | `e6905542` | `plan-spikes`, `plan-shared-prereqs`, `research-source-spikes`, `research-dir2-host`, `research-shared-invariants` | Fold A1/A2 disambiguation into each owner |
| `e1f98043` | `2a1108a9` | `plan-dir2-cache`, `plan-dir2-reference`, `plan-shared-prereqs`, `research-source-spikes`, `research-dir2-host`, `research-shared-invariants` | Fold five-table and batch-contract notes into each owner |
| `d7159cde` | `1fc472cd` | `plan-dir2-cache`, `plan-shared-prereqs`, `research-source-spikes`, `research-dir2-host`, `research-shared-invariants` | Fold seven-investigation notes into each owner |
| `7ba68ef3` | `cb5ab3ba` | `research-dir2-host` | D2 evidence map and host-requirements revisions |
| `a802b744` | `28ec77e0` | `plan-shared-prereqs`, `plan-dir2-reference` | Review corrections in the two plans |
| `473e5d01` | `9b3c591c` | `plan-shared-prereqs` | P/Q reconciliation |
| `2378aa72` | `c6e80143` | `plan-shared-prereqs` | Round-four corrections |
| `0a450650` | `0a3c7f1a` | `plan-shared-prereqs` | Round-five corrections and extracted `docs/backlog.md` |

Before splitting, verify the document map is path-complete: for each pushed SHA from `ffebc354` through `0a450650`, run `git diff-tree --no-commit-id --name-only -r <sha>` and diff the result against the ledger-owned paths; abort and remap on any unlisted, renamed, or deleted path before splitting. Reconstruct final document versions from the pushed tip and compare each branch's owned paths to that tip. A single source SHA may appear in several destination rows because it touched several files; its changes are divided by path and are not duplicated. Put prerequisite research before plans that cite it. Build research and plan branches from the lowest valid local base; place prerequisite research in their ancestry when a plan cites it so links resolve at its tip.

## U8 — Carry the two local-only commits

| Local commit | Destination branch | Thesis |
| --- | --- | --- |
| `daf8d746` | `billf/skip/build-capacity-note` | Apple container memory-capacity finding in `CONCEPTS.md` and `docs/solutions/build-errors/` |
| `ac39e72c` | `billf/convex/restack/adapter-metrics-review` | Convex adapter metrics review archive in `docs/research/convex-adapter-metrics-review.json` |

These commits are present only on local `billf/convex/adapter`; do not publish or reset that branch. The memory-capacity note is independent of the adapter and starts from the committed generated-files branch. The metrics review archive likewise starts from the committed generated-files branch tip and retains its provenance as a separate documentation thesis.

## U9 — Verify and commit local branches

Compare the rebuilt example content with PR #1, the combined adapter/research/plans result with PR #2, and the two local-only documents with local `billf/convex/adapter`. Account explicitly for expected base differences. The ledger must cover all 29 rows above, all 12 old PR #2 example SHAs as deduplicated equivalents, and the 15 local counterparts to PR #2's unique commits; commit count alone is not proof of content equality. Each fresh branch should normally contain one idiomatic commit stating why that thesis exists; fold later review edits into it. Save a source-SHA-to-destination-path audit to a durable location outside the scratch clone (e.g. `<worktree>/.restack-audit/convex-restack-2026-09-26.json`) and commit it on a local audit branch `billf/convex/restack-audit` so it survives `/tmp` cleanup or worktree switches, because a mixed source commit can contribute to several destination branches. Before declaring complete, read the ledger coverage check (29 rows plus 12 dedup equivalents plus 15 local counterparts) from that committed artifact and compare the final tree or owned-file bytes to the source tips; investigate any difference before completion.

Run per-branch TypeScript typechecks and relevant example/adapter tests for code branches. Check research and plan references against files available at each branch tip. Verify generated attributes with `git check-attr`, inspect ancestry and `git diff --check`, and review source-to-result tree differences. Commit each branch locally and record its name, tip SHA, owned paths, and source-commit mapping in the same durable audit artifact. Stop there: no push, stack submission, replacement PR creation, source PR closure, or worktree rebase is part of this plan. Keep `feat/skip-shared-prereqs` and its uncommitted `examples/convex_proof_harness/testdata/sse/` files untouched.

## Deferred / Open Questions

### From 2026-09-29 review

- **Every-branch attributes base contradicts code-only and lowest-base rules** — U1 — Bottom generated-files commit (P1, coherence, confidence 75)

  Implementers who rebase only code branches leave research, plan, and U8 branches without .gitattributes, so generated diffs reappear and ancestry verification fails. Implementers who build every branch directly from the attributes tip cannot also build stacked research-then-plan chains from prerequisite ancestry. The document forces a choice, guaranteeing rework on one reading.

- **Normally-one-commit thesis rule has no falsifiable thesis test** — U1-U9 Edict + U9 verify (one-thesis rule) (P1, adversarial, confidence 75)

  Without a criterion for what counts as one thesis versus two, branch granularity is a judgment call that later reviewers cannot falsify, so 24 branches may encode disputed boundaries as fact.

- **Material-change preservation assumes objective materiality** — U7 — stack-rewriter principle (P1, adversarial, confidence 75)

  Folders must decide what is material with no definition, examples, or arbiter, so two executors produce different final documents while both claiming compliance.
