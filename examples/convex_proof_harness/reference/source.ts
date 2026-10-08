/**
 * U11's reference source (KTD4, Q9): a hand-written `BaseConvexClient`
 * subscription to `proofVehicle/tables:allSelectedRows`. Each transition
 * that touches this query becomes exactly one `SnapshotBatch` write under a
 * single combined key ("allSelectedRows"), so one Convex transaction maps
 * to one Skip write (P3) -- this deliberately does not use
 * `@skip-adapter/convex`'s `ConvexExternalService`/`defineConvexReactiveResource`,
 * because that adapter computes bridge-side row diffs (`diffSnapshot`),
 * which P2 forbids for snapshot batches.
 *
 * Built on `addOnTransitionHandler`, not `subscribe`'s own `onUpdate`
 * (`ConvexClient` delivers `onUpdate` from a transition handler registered
 * earlier, so a timestamp read from a later handler would be one
 * transition stale -- KTD4). Every published batch is tagged with the
 * transition's own `timestamp`, which is gate 1's required version in this
 * same-session case.
 *
 * Also exposes the harness-only operations `run.ts` needs on this same
 * client session: issuing mutations (whose settling transition timestamp
 * is gate 1's required version for a direct delta) and awaiting the
 * marker-observed transition (gate 1's required version for a
 * loader-driven base load, KTD4).
 * docs/plans/2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U11, KTD4.
 */

import { BaseConvexClient } from "convex/browser";
import type { QueryToken } from "convex/browser";
import type { Value } from "convex/values";
import type { Entry, ExternalService, Json } from "@skipruntime/core";
import {
  applySnapshotBatch,
  buildSnapshotEntries,
  type Writer,
} from "@skip-adapter/atomic-batch";
import { CheckpointEmitter } from "../src/checkpoint.js";
import { HarnessError } from "../src/readiness.js";

/** `Transition` is internal to convex's sync client; extract it from the handler signature. */
type Transition = Parameters<
  Parameters<BaseConvexClient["addOnTransitionHandler"]>[0]
>[0];

/** convex's vendored `Long` has no `.toNumber()` (only `toString()` etc). */
function longToNumber(long: { toString(): string }): number {
  return Number(long.toString());
}

export const ALL_SELECTED_ROWS_QUERY = "proofVehicle/tables:allSelectedRows";
export const MARKER_MUTATION = "proofVehicle/fixture:marker";
const SNAPSHOT_KEY = "allSelectedRows";

export type TaggedRow = {
  readonly table: string;
  readonly doc: Record<string, unknown>;
};

type Subscriber = {
  readonly unsubscribe: () => void;
  readonly queryToken: QueryToken;
  readonly update: (
    entries: Entry<Json, Json>[],
    isInit: boolean,
  ) => Promise<void>;
  readonly error: (error: unknown) => void;
  hasInitialized: boolean;
};

/** One completed transition's observed rows and settled timestamp, as `run.ts` needs it. */
export type ObservedTransition = {
  readonly ts: number;
  readonly rows: readonly TaggedRow[];
};

function extractMarkerSequence(rows: readonly TaggedRow[]): number | undefined {
  const marker = rows.find((row) => row.table === "marker");
  const sequence = marker?.doc["sequence"];
  return typeof sequence === "number" ? sequence : undefined;
}

/**
 * The reference source's `ExternalService` implementation plus the
 * harness-only client operations `run.ts` drives it with. One instance
 * owns exactly one `BaseConvexClient` session, so every mutation this
 * harness issues and every row this source publishes share one timestamp
 * domain (KTD4's same-session case).
 */
export class ConvexReferenceSource implements ExternalService {
  private readonly client: BaseConvexClient;
  private readonly subscribers = new Map<string, Subscriber>();
  private latestObserved: ObservedTransition | undefined;
  private latestMutationCommit: number | undefined;
  private readonly transitionWaiters = new Set<
    (observed: ObservedTransition) => void
  >();

  constructor(
    convexUrl: string,
    private readonly checkpointEmitter: CheckpointEmitter,
  ) {
    this.client = new BaseConvexClient(convexUrl, () => {
      // Real work happens in the transition handler below; the
      // constructor's own onTransition callback is intentionally a
      // no-op (KTD4: an onUpdate-style callback registered here would
      // fire before addOnTransitionHandler's, missing the timestamp).
    });
    this.client.addOnTransitionHandler((transition) => {
      this.handleTransition(transition);
    });
  }

  async subscribe(
    instance: string,
    resource: string,
    _params: Json,
    callbacks: {
      update: (updates: Entry<Json, Json>[], isInit: boolean) => Promise<void>;
      error: (error: unknown) => void;
    },
  ): Promise<void> {
    if (resource !== SNAPSHOT_KEY) {
      throw new HarnessError(
        `ConvexReferenceSource: unknown resource "${resource}" (expected "${SNAPSHOT_KEY}")`,
      );
    }
    if (this.subscribers.has(instance)) {
      throw new HarnessError(
        `ConvexReferenceSource: instance "${instance}" is already subscribed`,
      );
    }
    const { queryToken, unsubscribe } = this.client.subscribe(
      ALL_SELECTED_ROWS_QUERY,
      {},
    );
    this.subscribers.set(instance, {
      queryToken,
      unsubscribe,
      update: callbacks.update,
      error: callbacks.error,
      hasInitialized: false,
    });
  }

  unsubscribe(instance: string): void {
    const sub = this.subscribers.get(instance);
    if (sub === undefined) return;
    sub.unsubscribe();
    this.subscribers.delete(instance);
  }

  async shutdown(): Promise<void> {
    for (const sub of this.subscribers.values()) sub.unsubscribe();
    this.subscribers.clear();
    await this.client.close();
  }

  private handleTransition(transition: Transition): void {
    for (const sub of this.subscribers.values()) {
      const match = transition.queries.find((q) => q.token === sub.queryToken);
      if (match === undefined) continue;
      if (match.modification.kind === "Removed") {
        sub.error(
          new HarnessError(
            "ConvexReferenceSource: allSelectedRows query was removed",
          ),
        );
        continue;
      }
      const result = match.modification.result;
      if (result === undefined) continue; // no result yet for this transition; nothing to publish
      if (!result.success) {
        sub.error(
          new HarnessError(
            `ConvexReferenceSource: allSelectedRows query failed: ${result.errorMessage}`,
          ),
        );
        continue;
      }
      const rows = result.value as unknown as TaggedRow[];
      const ts = longToNumber(transition.timestamp);
      const isInit = !sub.hasInitialized;
      sub.hasInitialized = true;
      const entries = buildSnapshotEntries([
        [SNAPSHOT_KEY, rows as unknown as Json[]],
      ]);
      const writer: Writer = { update: sub.update };
      applySnapshotBatch(
        writer,
        entries,
        isInit ? { isInit: true, liveKeys: [SNAPSHOT_KEY] } : { isInit: false },
      )
        .then(() => {
          this.checkpointEmitter.checkpoint(ts);
          const observed: ObservedTransition = { ts, rows };
          this.latestObserved = observed;
          for (const waiter of [...this.transitionWaiters]) waiter(observed);
        })
        .catch((error: unknown) => sub.error(error));
    }
  }

  /**
   * Issues a harness mutation over the same client session. Returns the
   * client's max observed timestamp once the mutation's promise resolves
   * -- "the timestamp current when a mutation's promise resolves is gate
   * 1's required version" (KTD4). This session serializes writes: await
   * each mutation before issuing the next so this timestamp is
   * unambiguous.
   */
  async mutation(
    name: string,
    args: Record<string, Value> = {},
    timeoutMs = 20_000,
  ): Promise<{ value: unknown; ts: number }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let value: unknown;
    try {
      // Note: the timeout rejects the caller but cannot cancel the mutation,
      // so a timed-out mutation may still commit late. Callers treat a
      // timeout as fatal for the run.
      value = await Promise.race([
        this.client.mutation(name, args),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new HarnessError(
                  `ConvexReferenceSource: mutation "${name}" did not settle within ${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const observedTs = this.client.getMaxObservedTimestamp();
    if (observedTs === undefined) {
      throw new HarnessError(
        `ConvexReferenceSource: no observed timestamp after mutation "${name}"`,
      );
    }
    const ts = longToNumber(observedTs);
    this.latestMutationCommit = ts;
    return { value, ts };
  }

  /** Read after the oracle promise settles, so an intervening harness mutation is visible. */
  get latestCommittedMutationVersion(): number | undefined {
    return this.latestMutationCommit;
  }

  /**
   * Issues `proofVehicle/fixture:marker` and waits for the first
   * source-session transition whose observed marker sequence is at or
   * past the returned ack -- gate 1's required version for a
   * loader-driven base load (KTD4), since the loader writes through a
   * separate `ConvexHttpClient` subprocess this session cannot read
   * timestamps from directly.
   */
  async issueMarkerAndAwaitObservation(): Promise<{
    ackSeq: number;
    observedSeq: number;
    ts: number;
  }> {
    const { value } = await this.mutation(MARKER_MUTATION, {});
    const ackSeq = (value as { marker: number }).marker;
    const observed = await this.awaitTransitionWhere((candidate) => {
      const seq = extractMarkerSequence(candidate.rows);
      return seq !== undefined && seq >= ackSeq;
    });
    const observedSeq = extractMarkerSequence(observed.rows);
    if (observedSeq === undefined) {
      throw new HarnessError(
        "ConvexReferenceSource: marker-satisfying transition lost its marker row",
      );
    }
    return { ackSeq, observedSeq, ts: observed.ts };
  }

  /**
   * The native oracle's one-shot read (Q2/KTD4): subscribes to `name`
   * with no standing subscriber, takes the first delivered result, then
   * unsubscribes -- on this same client session, so the returned `ts` is
   * directly comparable to every other gate this run uses (the same-
   * session timestamp domain KTD4 requires). Unlike `allSelectedRows`
   * (subscribed once, for the service's whole lifetime), a fresh
   * subscription is opened and closed per call so this read never becomes
   * a standing subscription the compared query and args could be biased
   * by.
   */
  async oneShotQuery(
    name: string,
    args: Record<string, Value> = {},
    timeoutMs = 20_000,
  ): Promise<{ ts: number; value: unknown }> {
    const { queryToken, unsubscribe } = this.client.subscribe(name, args);
    let unregister: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<{ ts: number; value: unknown }>(
        (resolve, reject) => {
          const finish = (
            result: { ts: number; value: unknown } | Error,
          ): void => {
            if (timer !== undefined) clearTimeout(timer);
            unregister?.();
            if (result instanceof Error) reject(result);
            else resolve(result);
          };
          const immediate = this.client.localQueryResult(name, args);
          if (immediate !== undefined) {
            const ts = this.client.getMaxObservedTimestamp();
            if (ts !== undefined) {
              finish({ ts: longToNumber(ts), value: immediate });
              return;
            }
          }
          unregister = this.client.addOnTransitionHandler((transition) => {
            const match = transition.queries.find(
              (q) => q.token === queryToken,
            );
            if (match === undefined) return;
            if (match.modification.kind === "Removed") {
              finish(
                new HarnessError(
                  `ConvexReferenceSource: one-shot query "${name}" was removed`,
                ),
              );
              return;
            }
            const result = match.modification.result;
            if (result === undefined) return;
            if (!result.success) {
              finish(
                new HarnessError(
                  `ConvexReferenceSource: one-shot query "${name}" failed: ${result.errorMessage}`,
                ),
              );
              return;
            }
            finish({
              ts: longToNumber(transition.timestamp),
              value: result.value,
            });
          });
          timer = setTimeout(
            () =>
              finish(
                new HarnessError(
                  `ConvexReferenceSource: one-shot query "${name}" did not settle within ${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          );
        },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unregister?.();
      unsubscribe();
    }
  }

  /**
   * Resolves with the first observed transition (past or future) satisfying
   * `predicate`. Bounded by `timeoutMs`: an unbounded wait here is
   * indistinguishable from a hang (no `allSelectedRows` transition ever
   * landing, e.g. because `subscribe` was never called against this
   * source), so a stuck wait fails loudly instead of sitting silently.
   */
  async awaitTransitionWhere(
    predicate: (observed: ObservedTransition) => boolean,
    timeoutMs = 20_000,
  ): Promise<ObservedTransition> {
    if (this.latestObserved !== undefined && predicate(this.latestObserved)) {
      return this.latestObserved;
    }
    return new Promise<ObservedTransition>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.transitionWaiters.delete(waiter);
        reject(
          new HarnessError(
            `ConvexReferenceSource: no matching transition observed within ${timeoutMs}ms ` +
              `(latest observed: ${this.latestObserved === undefined ? "none" : JSON.stringify(this.latestObserved.rows.map((r) => r.table))})`,
          ),
        );
      }, timeoutMs);
      const waiter = (observed: ObservedTransition): void => {
        if (!predicate(observed)) return;
        clearTimeout(timer);
        this.transitionWaiters.delete(waiter);
        resolve(observed);
      };
      this.transitionWaiters.add(waiter);
    });
  }

  /** The most recently published `allSelectedRows` snapshot, if any transition has landed yet. */
  get currentRows(): readonly TaggedRow[] | undefined {
    return this.latestObserved?.rows;
  }
}
