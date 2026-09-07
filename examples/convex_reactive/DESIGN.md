# Using Convex with Skip: findings and plan

## Conclusion

Convex can replace PostgreSQL as the source of truth in a Skip example, but it
is not a drop-in SQL adapter. Convex owns the database *and* the transactional
function API. Skip must subscribe through a public Convex query and should remain
a downstream derived-data system; writes go to Convex mutations, never to a
shadow Skip input collection.

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
- A rejected `callbacks.update` is recovered only by the next Convex snapshot,
  and Convex does not re-deliver an unchanged query result. So a transient Skip
  write failure on a dataset that then goes quiet leaves the projection stale
  indefinitely, with a log line as the only trace. The adapter deliberately does
  not advance its mirror past a batch Skip rejected -- which is what makes the
  next snapshot recover it -- but that is a repair mechanism, not a liveness
  guarantee. Production wants teardown and resubscribe on update failure, so the
  next delivery is a fresh initial batch.
- The Skip control and streaming listeners bind all interfaces (see the control
  API section below), so an unfirewalled dev machine exposes them to its whole
  local network.
- The in-memory previous snapshot is rebuilt after a Skip process restart. There
  is no durable resume token shared across Convex and Skip.
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

1. Extract the Convex adapter into a versioned package. Land as
   `@skip-adapter/convex` at `skipruntime-ts/adapters/convex`, versioned in
   lockstep with `@skipruntime/core` and pinning it exactly, and register it in
   the root `package.json` workspaces, `skipruntime-ts/metapackage`
   `optionalDependencies`, a `publish-convex-adapter` Makefile target inside
   `publish-all`, `skipruntime-ts/tests`, and the typedoc entries in
   `www/docusaurus.config.ts` and `www/sidebars.ts` -- the same set
   `@skip-adapter/postgres` occupies. Omitting the Makefile target ships a
   release without the adapter and nothing fails loudly.

   **Fold step 2's parameterisation into this step, before anything is
   published.** `ConvexReactiveResource` fixes `args` at construction and
   `subscribe` ignores its `params` argument, so every instance of a resource
   subscribes to the identical query -- which makes step 2 unreachable without
   breaking an already-released API. Skip already derives distinct external
   collection instances from `(supplier, resource, params)`; the adapter throws
   that away. Make the resource definition a factory over subscription params,
   validated the way `@skip-adapter/postgres` validates its required
   `params.key`, and give the Convex query declared `args` for the partition key.

   Still genuinely new work in this step: typed resource factories, schema
   validation, structured logging, and delivery latency metrics. Two items
   originally listed here are done -- row comparison is structural rather than
   `JSON.stringify`, and reconnect, callback-failure, unsubscribe and shutdown
   coverage exists in `skip/convex_subscribe.test.ts` in both examples; carry
   that suite into the package rather than rewriting it.

   Two contracts the extraction must state that the example never had to:
   - **Value domain.** Convex `Value` includes `bigint` (`v.int64`) and
     `ArrayBuffer` (`v.bytes`), neither of which is Skip `Json`. `exportJSON`
     throws an opaque wasm error on the former and silently exports the latter as
     `{}`. Reject both at the boundary with a named error, and require callers
     wanting them to supply a row encoder.
   - **Teardown ordering.** `unsubscribe` and `shutdown` drop the instance
     synchronously without draining the in-flight `delivery` chain, so a queued
     `callbacks.update` can run after Skip tore the collection down and throw
     back into the error path on every clean teardown under load. Serialize
     per-instance setup and teardown against the delivery chain, as
     `@skip-adapter/postgres` does with `chainInstanceOp`, and drop late
     deliveries for a released instance rather than reporting them as errors.
2. Replace the whole-workspace query with bounded partitions (for example one
   tenant or project per resource instance), using the parameterised resource API
   from step 1. Set and test hard cardinality and result-size limits, and specify
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
4. Add authentication and authorization **on both sides of the boundary**. On
   Convex, gate every client-callable mutation on `ctx.auth.getUserIdentity()`
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
