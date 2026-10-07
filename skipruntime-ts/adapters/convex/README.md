# @skip-adapter/convex

This adapter turns complete, reactive Convex query results into keyed deltas for
the Skip runtime. It is appropriate for bounded, tenant-scoped projections for
which a full query snapshot is an acceptable source transport.

It does not provide a durable change-log cursor. A Skip or adapter restart, and
recovery from a rejected Skip update, establish a new subscription and deliver a
fresh initial snapshot.

## Recovery and shutdown

A rejected `callbacks.update` tears the Convex subscription down and
re-establishes it, so the next delivery is a fresh initial batch rather than a
diff against a mirror Skip never accepted. Because Convex redelivers a cached
result as soon as a subscription is re-established, that recovery is capped:
`maxResubscribeAttempts` (default 5) consecutive failures with exponential
backoff from `resubscribeBackoffMs` (default 100, doubling up to a 30 second
ceiling), after which the subscription stops rather than spinning. An accepted
delivery resets the count. Both options are validated at construction:
`maxResubscribeAttempts` must be a non-negative integer (or `Infinity`) and
`resubscribeBackoffMs` a finite, non-negative number.

Only Skip rejecting a delivery is retried. A transport error from Convex itself
(the `onError` callback of the query subscription) is not: before the first
snapshot it rejects `subscribe`, and afterwards it is sent to `logger` and
`callbacks.error` while Convex keeps managing the connection. Releasing an
instance (`unsubscribe` or `shutdown`) before its first snapshot rejects the
pending `subscribe` call instead of leaving it waiting.

How a stopped subscription is reported depends on when it stopped. During
bootstrap, `subscribe` rejects with the failure. After it was delivering, the
failure goes to `logger` and `callbacks.error`, but Skip's runtime discards
`callbacks.error`, so pass `onInert(instance, error)` to learn that a projection
has stopped updating. The instance is released before the hook runs, so the
host can call `subscribe` again with the same id.

`shutdown` closes the Convex client only when this service constructed it from a
URL. A client you injected — including one from
`createAuthenticatedConvexClient` — is left open, because it is yours and may be
shared with other adapter instances or your own query code. Pass
`closeClient: true` to opt in to having it closed for you.

The `scope` you pass is copied and frozen at construction, so mutating your own
object afterwards cannot redirect a later subscription to another tenant.

## Installation

Install using npm (`npm i @skip-adapter/convex`).

## Authorization

Configure each adapter instance with one immutable tenant scope and construct
its `ConvexClient` with that tenant's trusted service token. A resource's
`argsFromParams` must reject caller-provided tenant values, inject the configured
tenant into the named Convex query arguments, and the Convex query must verify
that its authenticated identity may read that tenant. Do not pass browser tokens
or deployment credentials through Skip resource parameters.

See the Convex examples in this repository for the snapshot-to-delta boundary.

## Support

Join the [Discord](https://discord.gg/ss4zxfgUBH) to talk to other community
members and developers or ask any questions.
