# Skip backlog

Follow-ups outside the P/Q units (U1-U16). Not release blockers for
1a/1b/1c. Moved here from `docs/plans/2026-09-14-skip-shared-prerequisites-plan.md`
(doc-review round 4: Skip-local follow-ons exceed unblock goals).

- `skip-teardown-serialization` — serialize setup/teardown against the
  delivery chain; drop late deliveries, do not error. Seam:
  `adapters/postgres/src/index.ts:45-59` `chainInstanceOp`,
  `adapters/convex/src/index.ts:244-386`. Accept: `unsubscribe`
  mid-setup tears down once ready; no leak.
- `skip-structured-logging-latency` — structured logger +
  `delivered→applied→published` counters in `@skip-adapter/convex`.
  Accept: per-delivery timings in tests.
