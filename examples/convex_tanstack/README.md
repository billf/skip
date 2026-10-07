# Convex + Skip + TanStack example

This standalone sibling uses the same Convex-to-Skip pipeline as
`convex_reactive`, then adds two intentionally different TanStack integrations:

- TanStack Start and React Query use Convex's official adapter for loader-based
  SSR, hydration, and continued live subscriptions.
- TanStack DB treats the derived Skip SSE resource as a read-only normalized
  collection and runs a client-local live query over it.

## Run it

Requirements: Node.js 22.12 or newer (the floor TanStack Start declares) and a
Convex account (or a configured local Convex deployment).

```sh
cd ../..
npm install
npm run build
cd examples/convex_tanstack
npm run dev
```

This example is a root npm workspace. Install dependencies from the repository
root, then run its commands from this directory.

The first run configures Convex, writes `.env.local`, and then launches the Skip
service and TanStack Start. Open <http://localhost:3000> and select **Seed example
data**.

Run `npm test`, `npm run typecheck`, and `npm run build` for verification. The
build emits a fetch-style Start server entry; choose a supported deployment
adapter (for example Nitro) to serve it.

> **The development proxy for Skip is not a production gateway.** It forwards
> Skip's entire *control* API (port 8081) to the browser, including
> `PATCH /v1/inputs/:collection`, which writes. That is fine against a localhost
> listener and unsafe behind a public origin. A deployment should expose only the
> streaming port's `GET /v1/streams/:uuid` and mint stream UUIDs from its own
> authenticated endpoint; CORS is not a substitute, since it constrains
> cooperative pages rather than direct requests. See
> [DESIGN.md](../convex_reactive/DESIGN.md#the-skip-control-api-is-not-a-browser-facing-surface)
> for the full reasoning and `examples/hackernews` for a worked gateway split.

## What to inspect

- `src/router.tsx` connects one `ConvexQueryClient` to one React Query client and
  reuses its underlying `ConvexReactClient` in `ConvexProvider`.
- `src/routes/index.tsx` preloads the Convex query in the route loader, reads it
  with `useSuspenseQuery`, and keeps the Skip/TanStack DB portion client-only.
- `src/skip_collection.ts` is a small custom TanStack DB sync adapter. Skip's
  `init` event becomes an atomic truncate-and-insert transaction; later SSE
  events become insert/update/delete transactions.
- `@skip-adapter/convex` is the server-side Convex subscription adapter; it is
  deliberately separate from the browser's React Query client.

The larger design and rollout plan is in
[the native example's DESIGN.md](../convex_reactive/DESIGN.md).
