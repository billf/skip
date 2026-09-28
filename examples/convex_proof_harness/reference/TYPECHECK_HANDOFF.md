# U11/U15 typecheck cleanup — handoff for a fresh agent

## Context

`docs/plans/2026-09-11-1159-feat-skip-shared-prerequisites-plan.md` (in
`convex-backend`, branch `billf/prerequisites/sonnet`) is done except for U11
and U15. U11's implementation (`reference/service.ts`, `reference/source.ts`,
`reference/run.ts` in this package) is written and architecturally complete —
it faithfully implements KTD4 (marker-based gate-1 admission over a real
`BaseConvexClient` session, checkpoint emission, a genuine one-shot native
read instead of a faked always-admit version, a conformance check against the
real `skipruntime-ts/server/src/rest.ts` route registrars). It has **not**
been typechecked to a clean state, and the live run
(`npm run reference:snapshot`) has not yet succeeded end to end.

Read the plan's U11 (lines ~734-757) and U15 (lines ~806-817) for the full
spec before changing anything structural. Read `reference/service.ts`,
`reference/source.ts`, `reference/run.ts` in full before editing — do not
guess at their current shape from this document.

One genuine **runtime** bug (not just a type error) was already found and
fixed in this handoff: `Long` (convex's vendored timestamp type) has no
`.toNumber()` method, only `.toString()`. A `longToNumber()` helper was added
to `reference/source.ts` and all four call sites converted. If you see any
other `.toNumber()` call anywhere in `reference/`, it has the same bug — fix
it the same way.

## Reproduce

```sh
cd ~/src/skip/.worktrees/feat-skip-shared-prereqs/examples/convex_proof_harness
npx tsc --noEmit -p tsconfig.test.json
```

If this fails with `TS5033: Could not write file '...tsconfig.test.tsbuildinfo' ... EPERM`,
that's this package's build-info cache file being unwritable under an agent
sandbox that doesn't allow writes here — either run it from a normal
(non-sandboxed) terminal, or pass whatever your agent harness's sandbox-bypass
mechanism is for a single command once you've confirmed it's this cause (not
a stale/corrupt tsbuildinfo — deleting `tsconfig.test.tsbuildinfo` first is
also worth trying).

## Known remaining errors (from the last full clean run before this handoff)

None of these are runtime-breaking on their own (TypeScript's structural
typing is stricter than what JS actually does at runtime) — `tsx` (which
`reference:snapshot`/`reference:revision` use, not `tsc`) only strips types,
it does not enforce them. So the live run can be attempted before these are
all fixed. But they must all be clean before U11 can be marked `done` per the
plan's verification contract, and a couple could mask a real bug (the `Json`
constraint ones especially, since they might indicate `deriveRoomFeedInputs`
is being fed the wrong shape).

### `reference/run.ts`

- Line ~438 (`serverPackage` import): `TS2732: Cannot find module
  '../../../skipruntime-ts/server/package.json'... Consider using
  '--resolveJsonModule'`. This is a **dynamic** `import(..., { with: { type:
  "json" } })`, which works fine at runtime under modern Node — this is a
  `tsc`-only complaint. Fix by adding `"resolveJsonModule": true` to
  `tsconfig.test.json`'s `compilerOptions`, or by typing the import result as
  `unknown` and narrowing manually if you'd rather not touch the compiler
  options.
- `runDisconnectFault`'s `ctx: RunContext` parameter (~line 482): `TS6133:
  'ctx' is declared but its value is never read`. Genuinely unused. Check
  whether it *should* be used (e.g. to read `ctx.source`/`ctx.recorder` for
  the fault's own bookkeeping) before just deleting the parameter — re-read
  the function body and F4's description in the plan first.

### `reference/service.ts`

- `TableRowsById<V>`'s cast at the `mapEntry` return (~line 76): `TS2352:
  Conversion of type '...' to type 'V' may be a mistake`. Needs `V extends
  Json & { readonly _id: string }` as the class's generic constraint instead
  of just `{ readonly _id: string }`. Find `Json`'s actual definition first —
  it's exported from `@skipruntime/core` (see
  `skipruntime-ts/adapters/atomic-batch/dist/index.d.ts` line 13:
  `import type { Entry, Json } from "@skipruntime/core";` — grep
  `skipruntime-ts/core/src/api.ts` or wherever `@skipruntime/core`'s `Json`
  type is actually declared for its exact shape; do not guess a shape for
  it).
- Two `TS2344: Type 'unknown' does not satisfy the constraint 'Json'` errors
  (~lines 95, 111), inside `RoomFeedResourceWrapper.instantiate` /
  `GroupProbeResourceWrapper.instantiate` or their surrounding generic
  instantiations. Likely fixed once `TableRowsById`'s constraint above is
  fixed and flows through `Graph = RoomFeedInputs` correctly — re-run tsc
  after the above fix before spending time on these separately.
- `SplitByTable(SOURCE_COMPONENT, KNOWN_TABLES)` call (~line 135): `TS2345:
  Argument of type 'ReadonlySet<string>' is not assignable to parameter of
  type 'DepSafe'`. `room_feed.ts` in `@skip-adapter/atomic-batch` has its own
  documented convention for this (search it for `deepFreeze` — it likely
  already imports/uses a `deepFreeze` helper for the same reason on a similar
  argument). Apply the same pattern to `KNOWN_TABLES` here, e.g.
  `deepFreeze(KNOWN_TABLES)` at its point of use, importing whatever
  `deepFreeze` helper the adapter package itself uses (do not hand-roll a new
  one if one already exists and is exported/available).
- Two `TS2769: No overload matches this call` on `controlApp.get("/healthz",
  ...)` and the streaming app's equivalent (~lines 199, 244): Express's
  `RequestHandler` overload resolution trips on an arrow function with an
  expression body that returns `res.sendStatus(200)`'s return value. Fix by
  converting to a block body that doesn't return the value, matching the
  style already used a few lines above for `controlApp.delete(...)`:
  ```ts
  controlApp.get("/healthz", (_req, res) => {
  	res.sendStatus(200);
  });
  ```

### `reference/source.ts`

- `import type { QueryToken, Transition } from "convex/browser"` (~line 27):
  `TS2305: Module '"convex/browser"' has no exported member 'Transition'`.
  `Transition` is only exported from an internal `./sync/client.js` subpath,
  not the package's public `convex/browser` index. Replace the import with an
  extracted type:
  ```ts
  type Transition = Parameters<Parameters<BaseConvexClient["addOnTransitionHandler"]>[0]>[0];
  ```
  placed near the top of the file (after the `BaseConvexClient` import), and
  drop `Transition` from the `import type` line (keep `QueryToken`).
- `TS7006: Parameter 'q' implicitly has an 'any' type` in `handleTransition`'s
  `transition.queries.find((q) => q.token === sub.queryToken)` (~line 121, and
  the similar one in `oneShotQuery`, ~line 218 by old numbering). Should
  resolve on its own once `Transition` above is a real (non-erroring) type —
  re-run tsc first before touching these directly.
- Three `TS2345: Argument of type 'Record<string, unknown>' is not assignable
  to parameter of type 'Record<string, Value>'` on `.mutation(name, args)`,
  `.subscribe(name, args)` calls (~lines 159, 201, 204 by old numbering — the
  file has shifted by a few lines after the `longToNumber` fix above, re-find
  them). `Value` is convex's own args-value type, exported from
  `convex/values`. Either import `Value` from `"convex/values"` and change
  every `args: Record<string, unknown> = {}` parameter in this file to
  `args: Record<string, Value> = {}` (propagate to `mutation`,
  `issueMarkerAndAwaitObservation`, `oneShotQuery`, and their call sites in
  `run.ts`), or cast at the two-or-three call boundaries into
  `BaseConvexClient` itself if changing the public parameter type would
  ripple too far. Prefer the propagation — it's more honest about what these
  methods actually accept.

## After fixing

1. `npx tsc --noEmit -p tsconfig.test.json` clean (0 errors).
2. Hand the live run back to a human/terminal session — an agent's own
   sandboxed Bash tool typically cannot bind or connect to loopback, so it
   cannot itself run or watch `npm run reference:snapshot` against a real
   local deployment (see `docs/solutions/build-errors/agent-sandbox-blocks-loopback-network.md`
   in `convex-backend`). See this package's own `reference/run.ts` docstring
   and `scripts/skip-local-dev/README.md` (in `convex-backend`) for the
   env vars (`CONVEX_URL`, `PROOF_VEHICLE_ADMIN_KEY`) and prerequisites
   (`just skip-dev-up`) the live run needs.
3. Once `npm run reference:snapshot -w skip-convex-proof-harness` exits 0,
   implement U15 (`runRevisionReference` in `run.ts`, currently a stub that
   throws "not yet implemented") and get `npm run reference:revision` to exit
   0 too.
4. Update `docs/plans/2026-09-11-1159-feat-skip-shared-prerequisites-plan.md`'s
   frontmatter `units:` entries for U11 and U15 from `pending` to `done`,
   matching how every other unit in that file is already marked, and
   regenerate the `.ste.md` companion per that plan file's own header
   instruction.
