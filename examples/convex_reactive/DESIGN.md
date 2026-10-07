# Using Convex with Skip: findings and plan

## What this document is

A record of what was tried at one integration layer, and a plan for what a real
deployment would need. Three scope statements a reader should have before the
conclusions below:

- **It evaluates Convex's TypeScript client only.** Everything here rests on
  `ConvexClient.onUpdate`. Convex also ships an open-source backend and clients
  in other languages, and this document does not evaluate them. Where it says
  "Convex", read "Convex through its TypeScript client".
- **The demo is a mechanism demonstration, not a recommendation.** Its
  projection -- per-project task counts and effort sums over one Convex source --
  is deliberately below the threshold the Conclusion sets for using Skip at all,
  chosen so the boundary is legible rather than because it justifies the second
  reactive hop. A Convex-only implementation of this exact demo would be simpler
  and faster. The demo shows the boundary works; it does not show it is worth
  crossing.
- **The production plan describes work on the Skip repository**, not on this
  example, and it is a maintainer roadmap rather than a commitment. A downstream
  adopter should read it as a checklist of what they will have to solve, not as
  a list of things Skip already provides.

## Conclusion

Convex can replace PostgreSQL as the source of truth in a Skip example, but it
is not a drop-in SQL adapter. Convex owns the database *and* the transactional
function API. **At the TypeScript-client layer** Skip must subscribe through a
public Convex query, and it should remain a downstream derived-data system;
writes go to Convex mutations, never to a shadow Skip input collection.

That first constraint is a property of the layer, not of Convex. The sync
protocol carries whole query results -- `QueryUpdated` in
`convex/browser/sync/protocol` delivers `value: JSONValue`, the entire
re-evaluated result, with no row-level deltas anywhere -- so any client speaking
it, in any language, receives snapshots and must diff them to recover deltas.
This was checked against a second implementation rather than inferred from the
TypeScript declarations alone, because those declarations describe what one
client decodes and not what the server can emit: in the same file,
`ServerMessage` is a strict subset of `WireServerMessage`. Convex's Rust client
(`get-convex/convex-rs`, crate `convex_sync_types`, commit `dfc822f1`) decodes
the full wire set -- seven `ServerMessage` variants including `TransitionChunk`
and `Ping` -- and still declares no delta-shaped message. Its `StateModification`
matches the TypeScript one, its `QueryUpdated` carries a single whole `value`,
and its client applies that value by full replacement. No `ClientMessage` field
requests deltas or partial results. Rewriting the adapter against a
non-TypeScript client would therefore change nothing here.

A genuinely lower-layer integration would have to target a
different Convex surface (the open-source backend's subscription machinery, or
the cursor-based streaming-export API), which this document does not evaluate.
The snapshot layer is the explicit v1 transport: it re-establishes a fresh
snapshot after restart or delivery failure and makes no durable delta-replay
promise. A separately documented lower-layer discovery spike may evaluate
cursor-based transport without changing this adapter's v1 contract.

This is worth the extra system boundary when Skip is maintaining a shared,
incremental projection that is expensive or awkward to reproduce per client,
combines other Skip-supported sources, or already serves non-Convex consumers.
If a view is a small query over only Convex data, implement it as a Convex query
first. Convex already provides reactive dependency tracking, caching,
transactions, and a consistent client view, so adding Skip to that path would
usually duplicate machinery and add latency.

## Evidence from the source material

- Convex is a document-relational, ACID database whose deterministic queries
  react to the records they read; mutations are serializable transactions and
  actions are the non-transactional escape hatch for external effects. See the
  [overview](https://docs.convex.dev/understanding/overview) and
  [database overview](https://docs.convex.dev/database/overview).
- Convex recommends queries for nearly every read, keeping synchronous functions
  small and fast, and avoiding redundant client caches. It also recommends a
  mutation that records intent and schedules an action rather than calling an
  action directly from a browser. See the
  [Zen of Convex](https://docs.convex.dev/understanding/zen) and the
  [`useAction` API note](https://docs.convex.dev/api/modules/react#useaction).
- `ConvexReactClient.watchQuery` exposes the primitive behind React subscriptions,
  but application UI should normally use `useQuery`. The non-React
  `ConvexClient.onUpdate` is the appropriate equivalent inside a Node Skip
  adapter. See [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient)
  and [`ConvexClient`](https://docs.convex.dev/api/classes/browser.ConvexClient).
- Convex's React Query adapter preserves live updates rather than polling or
  treating results as stale. In TanStack Start, loader prefetching and
  `useSuspenseQuery` support SSR, and the browser resumes the live subscription.
  See [Convex with TanStack Start](https://docs.convex.dev/client/tanstack/tanstack-start/)
  and [Convex with TanStack Query](https://docs.convex.dev/client/tanstack/tanstack-query/).
- TanStack Query is an asynchronous server-state cache. TanStack DB builds typed
  normalized collections, local live queries, and optimistic transactions on
  top of data-loading or sync adapters. They are complementary, not alternative
  server databases. See the [TanStack Query repository](https://github.com/TanStack/query)
  and [TanStack DB repository](https://github.com/TanStack/db).

## Implemented data flow

```text
browser mutation ───────────────► Convex mutation/database
                                         │
                         reactive workspace.snapshot query
                                         │
                                  ConvexClient.onUpdate
                                         │
                              full-snapshot keyed diff
                                         │ one Skip update batch
                                         ▼
                         Skip map/reduce project summaries
                                         │
                                      Skip SSE
                                         │
                         React state or TanStack DB collection
```

The Convex query returns projects and tasks as one tagged collection. This is
intentional. Separate subscriptions would each be consistent inside Convex, but
their callbacks could enter Skip separately; a project update and related task
update could then briefly produce a mixed Skip input. One combined query result
is diffed and delivered through one `callbacks.update` call.

The adapter serializes deliveries because Skip's callback is asynchronous while
Convex's observer callback is not an async queue. It tracks previous keys so a
missing Convex row becomes Skip's `[key, []]` deletion representation. It also
owns unsubscribe and client shutdown lifecycles.

## Consistency boundary and limitations

The combined source snapshot makes each update *entering Skip* internally
consistent. It does not create a distributed transaction between Convex and
Skip. A mutation commits in Convex, the query reruns, the adapter receives it,
Skip recomputes, and SSE finally reaches the browser. A page showing a direct
Convex result beside a Skip result can temporarily show the new source with the
old projection. The examples expose both views to make this lag visible rather
than hiding it.

Other deliberate limitations:

- The demo query returns a full workspace and the adapter performs an O(n)
  JavaScript diff for every result. This follows the small-query guidance and is
  unsuitable for an unbounded table.
- The query *and the mutations* are public and unauthenticated. A real service
  needs a narrowly scoped service identity or a query that exposes only data safe
  for this backend, and identity checks on every client-callable mutation.
- A rejected `callbacks.update` tears down and re-establishes the Convex
  subscription, resetting the adapter mirror so the next delivery is a fresh
  initial batch. This restores a quiet dataset without waiting for another
  source write, but it is snapshot recovery rather than a durable replay log.
  Convex redelivers a cached result the moment a subscription is re-established,
  so recovery is bounded: capped exponential backoff, and after
  `maxResubscribeAttempts` consecutive failures the subscription goes inert and
  reports through `onInert`. Without the bound, a persistently failing Skip
  would be a hot loop.
- The Skip control and streaming listeners bind all interfaces (see the control
  API section below), so an unfirewalled dev machine exposes them to its whole
  local network.
- The in-memory previous snapshot is rebuilt after a Skip process restart.
  Convex's observed timestamp is a causal-consistency watermark, not a durable
  query replay cursor, so this adapter deliberately establishes a fresh initial
  snapshot instead of claiming delta resume.
- The handwritten `_generated` files let a clean scaffold typecheck; `convex dev`
  owns and regenerates them.
- The examples do not use actions because there is no external side effect. If
  one is added, a mutation should durably record the request and schedule it.
- TanStack DB's collection is read-only. Optimistically editing a derived Skip
  row would invent a second write authority. Mutations and optimistic source
  state belong on the Convex side.

## The Skip control API is not a browser-facing surface

Read this section before copying either example's `vite.config.ts`. It describes
a deliberate development-only shortcut that becomes a real vulnerability if it is
carried into a deployment unchanged.

`runService` starts **two** HTTP listeners, and they are not equivalent:

| Port | App | Routes |
| --- | --- | --- |
| 8080 | streaming | `GET /v1/streams/:uuid`, `GET /healthz` |
| 8081 | control | `POST /v1/streams/:resource`, `DELETE /v1/streams/:uuid`, `POST /v1/snapshot/:resource`, `POST /v1/snapshot/:resource/lookup`, `PATCH /v1/inputs/:collection`, `GET /healthz` |

The streaming port is a read-only fan-out of resource instances the control port
already minted. The control port is the service's administrative surface. It has
no authentication of its own -- Skip's REST layer does not attempt to model who
is calling, because it is designed to sit behind something that does. In
particular `PATCH /v1/inputs/:collection` **writes** into an input collection,
and `POST /v1/snapshot/:resource` reads any resource whole, regardless of which
resource a given browser is supposed to see.

These examples need exactly two of those routes: `POST /v1/streams/:resource` to
mint a stream, and `DELETE /v1/streams/:uuid` to release it on unmount. But the
Vite dev proxy in both examples forwards the entire prefix:

```ts
"/skip-control": {
  target: "http://localhost:8081",
  rewrite: (path) => path.replace(/^\/skip-control/, ""),
},
```

There is no path allowlist, so every control route -- including the write route
-- is reachable from the page. On a dev loop that is uninteresting: the proxy
adds no reach a local `curl` did not already have, and keeping the config to
four lines keeps the example about the Convex-to-Skip boundary rather than about
gateway configuration. **That is the whole justification, and it does not
survive deployment.** Behind a public origin the same shape hands every visitor
the ability to write into the service's input collections and to read any
resource snapshot by name.

Note that it is `runService` itself, not the proxy, that is permissive about
who can reach these ports. It calls `app.listen(port, callback)` -- the second
argument is the ready callback, not a host -- so both listeners bind all
interfaces and ports 8080 and 8081 are reachable from your whole local network
while the example runs. On an untrusted network (an office, a conference, a
coffee shop) bind them to loopback or firewall them before starting the service.

We are not fixing this in the examples, because a correct fix is a gateway
concern rather than an application concern, and inlining one here would teach the
wrong lesson about where the boundary lives. Instead, what a real deployment owes
you:

1. **Never route the control port to a browser origin.** Terminate it inside your
   own infrastructure. If a request from a browser can reach port 8081, the
   design is already wrong, and no amount of CORS configuration repairs it --
   CORS is a same-origin-policy relaxation enforced by the browser, so it
   restricts cooperative pages and does nothing about a direct request.
2. **Expose only the streaming port publicly**, and only the
   `GET /v1/streams/:uuid` route on it. A stream UUID is an unguessable
   capability -- `rest.js` mints it with `crypto.randomUUID()` and the browser
   never supplies it -- which is what makes this safe: the browser may read a
   stream it was given, and cannot enumerate or mint others. Treat it like a
   bearer token in a URL, with the handling that implies. `runService` installs
   a request logger that prints `req.originalUrl` for every request and response
   on both listeners, so Skip's own stdout carries every live stream UUID, and a
   fronting gateway's access log will carry it again. Redact the `:uuid` path
   segment before shipping logs anywhere, and keep stream ids out of
   `Referer`-leaking contexts.
3. **Mint and destroy streams server-side.** Your own authenticated endpoint
   decides which resource and parameters a given user is entitled to, calls the
   control port itself, and returns only the resulting UUID. Authorization is
   checked only at mint time: the streaming port re-checks nothing per event,
   and instances are reclaimed only after inactivity, which a held SSE
   connection never reaches. So track minted UUIDs against the session that owns
   them and `DELETE /v1/streams/:uuid` on logout, permission change, and session
   expiry. Never leave destruction to a client unmount handler, as the demo
   does.

`examples/hackernews` shows the **server-side half** of this split, and only
that half: `examples/hackernews/web_service/app.py` performs the control-port
call on the user's behalf and hands the browser only the resulting UUID. Read
that alongside this section.

Do not adopt its gateway configuration as-is. `reverse_proxy/haproxy.cfg`
carries a `listen control` block binding `:8081` straight to the reactive
service, proxying the whole control API with no path allowlist -- contained only
because `compose.yml` happens to publish just 80 and 443, so the safety property
comes from Docker port publishing rather than from the config itself. And
`kubernetes/ingress.yaml` routes a public `/control` path directly to port 8081,
which is exactly what rule 1 forbids.

## Production plan

Before adding parameterised or bounded resources, define the tenant boundary.
One production adapter instance has one immutable tenant scope and one trusted
Convex service identity. The gateway authorizes a caller before minting a stream,
the resource parser rejects a caller-supplied tenant, and the Convex query checks
both the identity and that the requested project belongs to the configured
tenant. End-user token propagation and shared multi-tenant adapter instances are
not part of this v1 shape.

1. The Convex adapter is now a versioned package: `@skip-adapter/convex` lives
   at `skipruntime-ts/adapters/convex`, is versioned in lockstep with
   `@skipruntime/core`, and is registered in the root workspaces, metapackage,
   release target, tests, and Typedoc configuration alongside
   `@skip-adapter/postgres`.

   **Parameterisation is part of the initial API.** `subscribe` continues to
   receive `Json`, as required by `ExternalService`; each resource supplies a
   named `argsFromParams` parser returning the generated
   `FunctionArgs<Query>`. That parser validates every caller-supplied field,
   rejects tenant overrides, and constructs the complete Convex argument object
   from the immutable scope and allowed subscription parameters. Do not use a
   generic `Record<string, Value>` argument bag or default-argument merging.

   The package includes typed resource factories, runtime scope and value-domain
   validation, structural row comparison, and coverage for reconnect,
   callback-failure, unsubscribe, and shutdown. The remaining follow-up work
   here is structured logging and delivery-latency metrics.

   Two package contracts the example did not need to state are now enforced:
   - **Value domain.** Convex `Value` includes `bigint` (`v.int64`) and
     `ArrayBuffer` (`v.bytes`), neither of which is Skip `Json`. The adapter
     rejects both at the boundary with a named error; callers that need them
     must map them to a string (or another Json value) in the Convex query.
   - **Teardown ordering.** `unsubscribe` and `shutdown` release the instance
     before waiting for the in-flight `delivery` chain, so late deliveries are
     dropped rather than reported as errors after Skip has torn the collection
     down.
2. Add the authenticated tenant-scoped query and gateway before exposing bounded
   partitions. Replace the whole-workspace query with bounded partitions (for
   example one project per resource instance within the adapter's fixed tenant),
   using the parameterised resource API from step 1. Set and test hard
   cardinality and result-size limits, and specify
   that exceeding one **fails the subscription loudly rather than truncating**:
   the adapter cannot distinguish a truncated snapshot from mass deletion, so a
   capped query reaches Skip as real deletions and produces confidently wrong
   aggregates.
3. Define the consistency contract: identify which Convex tables must share one
   query snapshot, document expected Convex-to-Skip lag, and ensure consumers do
   not require atomicity across the direct Convex and Skip streams. **State the
   partition invariant step 2 depends on**, because partitioning reintroduces the
   hazard the single combined query was chosen to avoid: N partitions are N
   independent subscriptions delivering into Skip separately, so a row moving
   between partitions appears as a delete in one and an insert in another, in
   either order. Require that a partition key is immutable for a row's lifetime
   and that every Skip aggregate is computable within one partition; cross-
   partition aggregation is out of scope for this integration shape.
4. Complete authentication and authorization **on both sides of the boundary**.
   On Convex, gate every client-callable mutation on `ctx.auth.getUserIdentity()`
   and demote anything that should never be browser-reachable to
   `internalQuery` / `internalMutation` -- the demo's `seed`, `addTask` and
   `advanceTask` are public `mutation`s and `VITE_CONVEX_URL` ships in the
   browser bundle by design, so an unauthenticated deployment is an
   internet-writable database. On the Skip side, give the long-lived server
   subscription a narrowly scoped service identity; note that Convex offers no
   static service key for websocket subscriptions, so this means standing up an
   OIDC/JWT issuer the deployment trusts via `auth.config.ts` and a refresh path
   for a process-lifetime subscription. Do not embed privileged deployment
   credentials in either browser bundle.
5. Put the Skip control and streaming APIs behind a production gateway, with
   TLS, SSE timeouts/reconnect behavior, health checks, and explicit resource
   cleanup. Include the authenticated backend endpoint that mints and destroys
   streams on the user's behalf (rule 3 above) -- a gateway alone does not
   provide it, and without it the browser still reaches stream minting directly.
6. Load-test initial snapshot cost, steady-state update fan-out, and TanStack
   Query `gcTime`. Exercise Convex disconnect, Skip restart, malformed rows, and
   a slow `callbacks.update` path.
7. Compare the result with a Convex-only implementation. Keep Skip only where
   its incremental/multi-source/server-shared computation justifies the second
   reactive hop.

## Lower-layer replay discovery spike

This v1 adapter is not blocked on a lower-layer transport. Timebox investigation
to one engineer-week: inspect the supported backend/export surfaces, prototype a
tenant-authenticated cursor consumer, and exercise bootstrap, disconnect,
duplicate, gap, retention, and compaction cases. The spike must answer whether a
supported API supplies ordered document changes with durable cursors, whether it
can recreate the query's tenant-scoped semantics without a bootstrap gap, and
what state/retention it requires. A viable production replay adapter is expected
to require roughly four to eight further engineer-weeks plus persistent cursor
storage, monitoring, and operational support; that estimate is intentionally
low-confidence until the spike completes.
