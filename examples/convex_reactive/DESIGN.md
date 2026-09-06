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
- The query is public and unauthenticated. A real service needs a narrowly scoped
  service identity or a query that exposes only data safe for this backend.
- The in-memory previous snapshot is rebuilt after a Skip process restart. There
  is no durable resume token shared across Convex and Skip.
- The handwritten `_generated` files let a clean scaffold typecheck; `convex dev`
  owns and regenerates them.
- The examples do not use actions because there is no external side effect. If
  one is added, a mutation should durably record the request and schedule it.
- TanStack DB's collection is read-only. Optimistically editing a derived Skip
  row would invent a second write authority. Mutations and optimistic source
  state belong on the Convex side.

## Production plan

1. Extract the Convex adapter into a versioned package with typed resource
   factories, schema validation, structured logging, delivery latency metrics,
   and tests for reconnect, callback failure, unsubscribe races, and shutdown.
2. Replace the whole-workspace query with bounded partitions (for example one
   tenant or project per resource instance). Set and test hard cardinality and
   result-size limits.
3. Define the consistency contract: identify which Convex tables must share one
   query snapshot, document expected Convex-to-Skip lag, and ensure consumers do
   not require atomicity across the direct Convex and Skip streams.
4. Add authentication and authorization for the long-lived server subscription.
   Do not embed privileged deployment credentials in either browser bundle.
5. Put the Skip control and streaming APIs behind a production gateway, with
   TLS, SSE timeouts/reconnect behavior, health checks, and explicit resource
   cleanup.
6. Load-test initial snapshot cost, steady-state update fan-out, and TanStack
   Query `gcTime`. Exercise Convex disconnect, Skip restart, malformed rows, and
   a slow `callbacks.update` path.
7. Compare the result with a Convex-only implementation. Keep Skip only where
   its incremental/multi-source/server-shared computation justifies the second
   reactive hop.
