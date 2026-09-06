# Convex reactive example

This example replaces the PostgreSQL source used by several other Skip examples
with Convex. Convex remains the system of record and owns every write. A custom
Skip `ExternalService` subscribes to one reactive Convex query, turns successive
snapshots into keyed deltas, and feeds an incremental Skip project-workload
projection. The React UI deliberately shows the native Convex subscription next
to the Skip SSE resource.

## Run it

Requirements: Node.js 20 or newer and a Convex account (or a configured local
Convex deployment).

```sh
cd examples/convex_reactive
npm install
npm run dev
```

The first run of `convex dev` asks you to configure a deployment and writes
`.env.local`. Its `--start` command then launches the Skip service and Vite. Open
<http://localhost:5173> and select **Seed example data**.

Useful separate-process commands after the deployment is configured:

```sh
npx convex dev
npm run skip:dev
npm run web:dev
```

Run `npm test`, `npm run typecheck`, and `npm run build` for local verification.
The Vite proxy is development-only; a deployed version needs a gateway routing
the two Skip HTTP/SSE ports under the same public origin (or an equivalent CORS
configuration).

## What to inspect

- `convex/workspace.ts` exposes a single cross-table snapshot and transactional
  mutations.
- `skip/convex_external_service.ts` adapts `ConvexClient.onUpdate` to Skip's
  external-resource lifecycle and diffs full snapshots, including deletions.
- `skip/service.ts` splits the tagged snapshot and incrementally maintains task
  counts and effort by project.
- `src/App.tsx` uses `ConvexReactClient`, `useQuery`, and `useMutation` directly.
- `src/skip_stream.ts` consumes the derived Skip resource over SSE.

See [DESIGN.md](./DESIGN.md) for the architectural conclusions, limitations,
and production plan. The sibling [TanStack example](../convex_tanstack/README.md)
uses the same boundary with TanStack Start, Query, and DB.
