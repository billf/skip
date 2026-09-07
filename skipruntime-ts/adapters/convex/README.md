# @skip-adapter/convex

This adapter turns complete, reactive Convex query results into keyed deltas for
the Skip runtime. It is appropriate for bounded, tenant-scoped projections for
which a full query snapshot is an acceptable source transport.

It does not provide a durable change-log cursor. A Skip or adapter restart, and
recovery from a rejected Skip update, establish a new subscription and deliver a
fresh initial snapshot.

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
