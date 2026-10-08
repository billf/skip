/**
 * U15's scripted revision-delta reference source (F2): replays rows
 * directly as `RevisionDeltaBatch` envelopes (P4/P5) through
 * `@skip-adapter/atomic-batch`'s `RevisionDeltaSource`, feeding the SAME
 * room-feed/`groupProbe` graph `service.ts`'s `createReferenceService`
 * builds for U11's snapshot path -- `split.ts`'s `SplitByTable` accepts
 * both `TaggedRow` and `RevisionEnvelope` input shapes, so no graph change
 * is needed here.
 *
 * The source runs the production path: the generation is promoted once with
 * `promoteWith` (the empty `isInit` snapshot), and every group is delivered
 * by the live `applyGroup`, whose publish payload is already the
 * `RevisionEnvelope` entries `SplitByTable` reads -- no reshaping and no
 * cast. (This used to loop the staging-only `applyEntry` and hand-publish
 * envelopes, so the run never exercised `applyGroup`'s publish-then-commit
 * ordering.)
 *
 * Unlike `source.ts`'s `ConvexReferenceSource` (one Convex transaction ->
 * one combined-key `SnapshotBatch` write, publishing the WHOLE row array
 * under a single key), this source publishes one row -> one per-row key.
 * One `applyGroup` call is one atomic push: every row's applied change is
 * collected and delivered to the subscriber in a SINGLE `update()` call
 * once the whole group has landed, so a single `applyGroup` call never
 * looks torn on its own. A caller that wants to prove a seeded split IS
 * torn achieves that by calling `applyGroup` twice -- once per logical
 * write -- each with its own independent `update()` push, letting Q14's
 * `NoTornObserver` catch the genuinely torn intermediate state between the
 * two calls. A whole group's completion (`applyGroup`) is what triggers
 * this run's checkpoint event, reusing U11's SAME gate-2
 * SSE/`ReadinessDetector` machinery unchanged.
 *
 * Scripted, not live-Convex-backed: U15 proves F2 end to end against the
 * real Skip runtime and the real room-feed/groupProbe graph, not against a
 * live deployment (the plan's "same live-deployment dependency as U11"
 * refers to needing the same built-toolchain environment up, not an actual
 * `CONVEX_URL` connection for the delta mechanics themselves).
 * docs/plans/2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U15,
 * P3, P4, P9, Q14, F2.
 */

import type { Entry, ExternalService, Json } from "@skipruntime/core";
import {
  RevisionDeltaSource,
  type GenerationId,
  type RevisionDeltaEntry,
} from "@skip-adapter/atomic-batch";
import { CheckpointEmitter } from "../src/checkpoint.js";
import { HarnessError } from "../src/readiness.js";
import { ALL_SELECTED_ROWS_RESOURCE, SOURCE_COMPONENT } from "./service.js";

export { ALL_SELECTED_ROWS_RESOURCE as REVISION_RESOURCE } from "./service.js";

/** One scripted row: a table tag plus a document already carrying `_id`/`_creationTime`, matching room_feed.ts's per-table doc shapes. */
export type ScriptedRow = {
  readonly table: string;
  readonly _id: string;
  readonly _creationTime: number;
  readonly doc: Json;
};

/** One page/group: rows sharing one exact `ts`, applied together and completed as a unit. */
export type RevisionGroup = {
  readonly ts: number;
  readonly rows: readonly ScriptedRow[];
};

type Subscriber = {
  readonly update: (
    entries: Entry<Json, Json>[],
    isInit: boolean,
  ) => Promise<void>;
  readonly error: (error: unknown) => void;
};

export class RevisionDeltaReferenceSource implements ExternalService {
  private readonly deltaSource = new RevisionDeltaSource<Json>();
  private readonly generationId: GenerationId;
  private subscriber: Subscriber | undefined;
  private groupCounter = 0;

  constructor(private readonly checkpointEmitter: CheckpointEmitter) {
    this.generationId = this.deltaSource.beginGeneration();
  }

  async subscribe(
    instance: string,
    resource: string,
    _params: Json,
    callbacks: Subscriber,
  ): Promise<void> {
    if (resource !== ALL_SELECTED_ROWS_RESOURCE) {
      throw new HarnessError(
        `RevisionDeltaReferenceSource: unknown resource "${resource}" (expected "${ALL_SELECTED_ROWS_RESOURCE}")`,
      );
    }
    if (this.subscriber !== undefined) {
      throw new HarnessError(
        `RevisionDeltaReferenceSource: instance "${instance}" is already subscribed`,
      );
    }
    this.subscriber = callbacks;
    // Starts empty; every row this run cares about arrives through a
    // later `applyGroup` call, not an initial snapshot. Promoting publishes
    // that empty state as the one `isInit` update and makes the generation
    // live, so `applyGroup` below delivers through the production path.
    const promoted = await this.deltaSource.promoteWith(
      this.generationId,
      (changes) => callbacks.update(changes, true),
    );
    if (!promoted) {
      throw new HarnessError(
        "RevisionDeltaReferenceSource: initial promotion was dropped as a late generation",
      );
    }
  }

  unsubscribe(_instance: string): void {
    this.subscriber = undefined;
  }

  async shutdown(): Promise<void> {
    this.subscriber = undefined;
  }

  /**
   * Applies one group's rows as one page (P9's per-page ledger, one
   * group id) and pushes every newly-applied change to the subscriber
   * in a SINGLE `update()` call once the whole group has landed -- an
   * atomic group must reach the SSE consumer as one event, not one per
   * row, or every group (not just a seeded split) would look torn. A
   * caller that wants to prove a seeded split IS torn achieves that by
   * calling `applyGroup` twice, once per logical write, each with its
   * own independent `update()` push. Marks the group complete and
   * emits this run's checkpoint for `group.ts` once every row has been
   * applied (or ignored as a replay).
   */
  async applyGroup(group: RevisionGroup): Promise<{ replayedIgnored: number }> {
    const subscriber = this.subscriber;
    if (subscriber === undefined) {
      throw new HarnessError(
        "RevisionDeltaReferenceSource: applyGroup called before subscribe",
      );
    }
    const groupId = `group-${this.groupCounter++}`;
    const ledger = this.deltaSource.beginPage(this.generationId, [groupId]);
    if (ledger === undefined) {
      throw new HarnessError(
        "RevisionDeltaReferenceSource: stale generation (beginPage refused)",
      );
    }
    const entries: RevisionDeltaEntry<Json>[] = group.rows.map((row) => ({
      ts: String(group.ts),
      deleted: false,
      component: SOURCE_COMPONENT,
      table: row.table,
      _id: row._id,
      _creationTime: row._creationTime,
      doc: row.doc,
    }));
    // One atomic push: the live applyGroup hands every changed key to
    // `update()` in a single call, then commits the watermarks and snapshot
    // only after Skip accepted it.
    const result = await this.deltaSource.applyGroup(
      this.generationId,
      ledger,
      groupId,
      entries,
      (changes) => subscriber.update(changes, false),
    );
    if (result.status === "late-generation-dropped") {
      throw new HarnessError(
        `RevisionDeltaReferenceSource: group "${groupId}" was dropped as a late generation`,
      );
    }
    this.checkpointEmitter.checkpoint(group.ts);
    return { replayedIgnored: result.replayIgnored };
  }

  /** F2's replay-idempotency counter (`RevisionDeltaApplier.replayedIgnored`), scoped to this source's one live generation. */
  get replayedIgnored(): number {
    return this.deltaSource.replayedIgnored(this.generationId);
  }
}
