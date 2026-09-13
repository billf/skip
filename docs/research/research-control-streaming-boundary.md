---
title: Control vs streaming boundary
type: research-note
status: active
direction: foundation
date: 2026-09-13
---

# Control vs streaming boundary

`runService` starts two HTTP listeners that are not equivalent. Spikes
need exactly two control routes; everything else must stay behind a
gateway. This doc restates the rule from
`examples/convex_reactive/DESIGN.md:162-253` with Skip-repo lines so
spike harnesses do not copy the dev shortcut into anything public.

## Two listeners

- `server/src/server.ts:105-176` `runService(service,{streaming_port:8080,
  control_port:8081})`: two Express apps, dual `app.listen(port,callback)`
  — the second argument is the ready callback, not a host, so both bind
  all interfaces while the example runs.
- `server/src/rest.ts:11-108` control routes: `POST /v1/streams/:resource`
  (mint, `crypto.randomUUID`), `DELETE /v1/streams/:uuid`,
  `POST /v1/snapshot/:resource`, `POST /v1/snapshot/:resource/lookup`,
  `PATCH /v1/inputs/:collection` (writes an input collection),
  `GET /healthz`. No authentication — designed to sit behind something
  that authenticates.
- `rest.ts:110-165` streaming routes: `GET /v1/streams/:uuid` SSE
  (`event:init|update`, `id:watermark`, 30s heartbeat) + `GET /healthz`.
  Read-only fan-out of instances the control port already minted.

## Deployment rules (from DESIGN.md)

1. Never route the control port to a browser origin. CORS does not repair
   it — it restricts cooperative pages, not direct requests.
2. Expose only `GET /v1/streams/:uuid` publicly. The UUID is an
   unguessable capability (`rest.js` mints with `crypto.randomUUID()`,
   browser never supplies); treat like a bearer token, redact `:uuid`
   from shipped logs (`logger_middleware` in `server.ts:191-214` prints
   `originalUrl` on both listeners), keep out of `Referer`-leaking
   contexts.
3. Mint and destroy streams server-side: an authenticated endpoint decides
   entitlement, calls control itself, returns only the UUID; track UUIDs
   against sessions and `DELETE` on logout/permission-change/expiry.
   Authorization is checked only at mint time; a held SSE connection never
   reaches instance reclamation.

Dev shortcut not to copy: both `convex_reactive` and `convex_tanstack`
`vite.config.ts` proxy the entire `/skip-control` prefix to `:8081` with
no path allowlist — four lines that keep the example about the
Convex-to-Skip boundary, unjustified past a dev loop. `hackernews`
shows the server-side half (`web_service/app.py` calls control on the
user's behalf); its `haproxy.cfg`/`ingress.yaml` control exposures are
explicitly not to adopt as-is (contained only by Docker port publishing,
or directly violating rule 1).

Probe: none code-side; gateway checklist only. On untrusted networks bind
to loopback or firewall before starting the service.

## What this adds vs convex-backend notes

Spike plans assume a harness that mints streams; this doc tells that
harness which two routes it may use and what it must not expose, with the
exact Skip-repo route table.

## Sources

- `skipruntime-ts/server/src/server.ts:105-214`
- `skipruntime-ts/server/src/rest.ts:11-165`
- `skipruntime-ts/helpers/src/rest.ts`, `helpers/src/remote.ts:48-77`
- `examples/convex_reactive/DESIGN.md:162-253`
- `examples/hackernews/web_service/app.py`
