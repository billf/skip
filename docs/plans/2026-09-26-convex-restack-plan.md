---
title: Convex stack restack into one-thesis PRs
type: plans-process
status: draft
direction: cross-cutting
date: 2026-09-26
---

# Convex stack restack into one-thesis PRs

Restack the pushed Convex work — PR #1 (`billf/convex/example`,
`main` <- 12 commits ending `c909d6c7`) and PR #2
(`billf/convex/adapter-2`, 4 commits atop PR #1 ending `cf141bb2`) —
into 15 one-thesis branches plus a leading generated-files commit,
submitted as a fresh stack. PRs #1/#2 close after the new stack lands
(settled in review 2026-09-26; alternative of rewriting them in place
was rejected in favor of a clean history).

Edict: one thesis per PR. Local `billf/convex/adapter` in `~/src/skip`
has diverged with `docs(plans)` commits, so all split work happens in a
clean scratch worktree rooted at `origin/*`, never in `~/src/skip`.

## U1 — Bottom generated-files commit (lands first)

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
the root lockfile (present on `main`) and both example lockfiles. This
PR lands first so every restacked branch inherits collapsed generated
diffs. Non-example worktrees (`sync-upstream`, `upstream`,
`feat/skip-shared-prereqs`) benefit only after rebasing onto the new
bottom. Verify with `git check-attr linguist-generated -- <paths>`.

## U2 — Scratch setup and safety

`git fetch origin`; save `main..origin/billf/convex/example` and
`origin/billf/convex/example..origin/billf/convex/adapter-2` SHAs;
cut `backup/convex-presplit` branches (repo already uses `backup/*`);
`git worktree add /tmp/split-convex origin/billf/convex/example`;
`gs branch checkout billf/convex/example` (no worktree currently holds
the example branch, so checkout is conflict-free).

## U3 — Split the example branch (10-segment map)

Each `--at` names the tip of its segment; bottom (`b436ce57`, the
reactive-example scaffold) and HEAD (`c909d6c7`, the adapter-parity
fix) are named explicitly because `gs` keeps the original branch name
at HEAD by default:

```bash
gs branch split \
  --at b436ce57:billf/convex/example \
  --at ac10bab1:billf/convex/example-tanstack \
  --at 6b962166:billf/convex/mirror-fix \
  --at 425735eb:billf/convex/sync-guard \
  --at e506bc66:billf/convex/adapter-seam \
  --at 6e049b12:billf/convex/design-docs \
  --at a7d62750:billf/convex/adapter-contracts \
  --at 3011cf0d:billf/convex/adapter-lifecycle \
  --at 43340dab:billf/convex/service-api-compat \
  --at c909d6c7:billf/convex/adapter-parity
```

Every shipped commit is covered: the convex-rs verification (`6e049b12`)
extends the docs branch, and the lifecycle-hardening pair (`51b07061`,
`3011cf0d`) gets its own branch, so no untipped commit rolls uphill
into a branch whose thesis never mentions it.

Segment theses: reactive scaffold only; TanStack frontend (notes the
adapter is still a copy at this point); mirror-advance correctness;
sync-transaction guard plus projection tests; publishability seam
(structural diff, subscriber injection); DESIGN.md plus control-API
docs plus convex-rs verification; pre-extract defect teardown;
subscription lifecycle hardening plus bootstrap retry; SkipService API
compat; adapter parity restoration.

Unverified: exact multi-`--at` segment ownership is inferred from
`gs branch split --help` ("if the original branch is assigned to one
of the splits, a new name is required for HEAD"). Trial in build mode
and adjust the map before pushing.

## U4 — Hunk-split the mixed commits at branch tips

`gs commit split` operates on the current commit, so `gs branch edit`
each mixed commit to its branch tip first, then split: the
transaction-guard commit's code half stays in `sync-guard`, its prose
(DESIGN.md, READMEs, vite configs) moves to `design-docs`; frontend
hunks leave the contracts commit. For the giant move commit prefer
path-based `reset` plus staged commits over interactive splitting
through ±10k lockfile churn.

## U5 — Split the adapter range

Onto the new top, split `f5a3a42f` (the shared-adapter extraction)
into move-only (`skipruntime-ts/adapters/convex` sources, example
adapter deletions, import rewiring) versus workspace-plus-wiring (root
`package.json`/`package-lock.json`, example lockfile deletions,
`Makefile` publish target, metapackage, docs site, `core/src/api.ts`,
`tsconfig.test.json`), then `recovery-bounds` (`94dcdee9`, bounded
backoff with terminal state), `ownership` (`637e2c95`, frozen scope
and caller-owned clients), `bootstrap-retry` (`cf141bb2`).

Transplant the four commits onto the new top with `git cherry-pick`
(or `gs commit pick`); note the adapter head replays example-range
history below `f5a3a42f`, so expect context drift where the extraction
touches files the split already moved, and resolve in favor of the
split branches.

## U6 — Verify, submit, close

Per-branch `tsc --noEmit` and example/adapter tests; `gs branch
restack`; `gs stack submit --dry-run` then `--fill`; land the new
stack; close PRs #1/#2. `feat/skip-shared-prereqs` stays untouched in
its worktree until the new stack lands, then moves via `gs branch
onto` the new top.
