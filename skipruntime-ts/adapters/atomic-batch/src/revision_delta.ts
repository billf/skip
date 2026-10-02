/**
 * P4/P5's revision-delta extension: the envelope, in-value watermark
 * idempotency, and tombstone/GC convention, wired to `generation.ts`'s
 * fencing and staging primitives (P9) into one source-facing API. This is
 * the state machine and bookkeeping 1c's U4
 * (`docs/plans/2026-09-10-1854-feat-skip-data-sync-push-source-spike-plan.md`)
 * consumes rather than reimplementing.
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U13,
 * P4, P5, P9.
 */

import type { Entry, Json } from "@skipruntime/core";
import { GenerationManager, type GenerationId, type PendingPageLedger } from "./generation.js";

export type { GenerationId, PendingPageLedger } from "./generation.js";

/**
 * One revision-delta envelope. `ts` is carried as a string or `bigint`
 * (never a plain `number`) because Convex/Data-Sync timestamps routinely
 * exceed `2^53`, where `number` silently loses precision; `doc` is `null`
 * for a tombstone (`deleted: true`).
 */
export type RevisionDeltaEntry<Doc extends Json> = {
	readonly ts: string | bigint;
	readonly deleted: boolean;
	readonly component: string;
	readonly table: string;
	readonly _id: string;
	readonly _creationTime: number;
	readonly doc: Doc | null;
};

/** Converts a revision timestamp to `BigInt`, rejecting malformed input with a clear `Error` (never a raw `SyntaxError`). */
function toBigInt(ts: string | bigint, context: string): bigint {
	if (typeof ts === "bigint") return ts;
	try {
		return BigInt(ts);
	} catch {
		throw new Error(`invalid revision timestamp ${context}: ${JSON.stringify(ts)} (expected a decimal integer string or bigint)`);
	}
}

/** Compares two revision timestamps exactly, regardless of magnitude (both convert through `BigInt`). Throws an `Error` on malformed input. */
export function compareTs(a: string | bigint, b: string | bigint): number {
	const ai = toBigInt(a, "in compareTs(a)");
	const bi = toBigInt(b, "in compareTs(b)");
	return ai < bi ? -1 : ai > bi ? 1 : 0;
}

type RetainedRevision<Doc extends Json> = { readonly ts: string | bigint; readonly deleted: boolean; readonly doc: Doc | null };

function retentionKey(entry: { component: string; table: string; _id: string }): string {
	return `${entry.component}\u0000${entry.table}\u0000${entry._id}`;
}

/**
 * In-value watermark idempotency (P4) plus the tombstone/GC convention
 * (P5), scoped to one generation: a fresh instance per generation is what
 * makes watermarks generation-scoped in practice, since
 * `GenerationManager` discards the whole generation (including its
 * applier) wholesale on swap.
 *
 * GC keeps a permanent per-key low-watermark (`max swept ts`) that
 * survives `sweepTombstones`: a replay at or under a key's watermark is
 * ignored as stale and can never resurrect a swept tombstone. The
 * watermark map is append-only by design (one small entry per swept key)
 * -- that is the cost of the never-resurrect guarantee.
 *
 * Counter semantics: `replayedIgnored` counts verified ignored replays
 * only (an entry whose `ts` is at/under the retained `ts` or the swept
 * watermark). Query-only checks (`retainedSize`) never increment it, and
 * invalid entries throw before any counting or retaining.
 */
export class RevisionDeltaApplier<Doc extends Json> {
	private readonly retained = new Map<string, RetainedRevision<Doc>>();
	private readonly watermarks = new Map<string, string | bigint>();
	private replayedIgnoredCount = 0;

	/**
	 * Applies `entry` iff its `ts` is strictly greater than the retained
	 * `ts` for its `(component, table, _id)` key -- never Skip's own
	 * subscription/session-tick watermark (P4). Returns the resulting
	 * `[key, values[]]` entry (P2's shape; an empty array is a tombstone,
	 * derived from the retained value, never resurrectable by an
	 * out-of-order replay) or `undefined` if the entry was a replay and was
	 * ignored.
	 *
	 * Rejects invalid envelopes before retaining anything: `deleted: false`
	 * requires a non-null `doc`, and `deleted: true` requires `doc: null`.
	 * Malformed `ts` values throw an `Error` carrying the entry's key, not
	 * a raw `SyntaxError`.
	 */
	apply(entry: RevisionDeltaEntry<Doc>): Entry<string, Doc> | undefined {
		const key = retentionKey(entry);
		const where = `for key "${key}" (table "${entry.table}", _id "${entry._id}")`;
		if (!entry.deleted && entry.doc === null) {
			throw new Error(`invalid RevisionDeltaEntry ${where}: deleted:false requires a non-null doc`);
		}
		if (entry.deleted && entry.doc !== null) {
			throw new Error(`invalid RevisionDeltaEntry ${where}: deleted:true requires doc:null`);
		}
		// Validate the incoming ts before any comparison, counting, or
		// retaining, so a malformed ts throws an `Error` with entry
		// context instead of a raw `SyntaxError` from `BigInt()`.
		// (Retained and watermark timestamps were validated when written,
		// so only the incoming ts can fail here.)
		toBigInt(entry.ts, where);
		const prior = this.retained.get(key);
		if (prior !== undefined && compareTs(entry.ts, prior.ts) <= 0) {
			this.replayedIgnoredCount += 1;
			return undefined;
		}
		const watermark = this.watermarks.get(key);
		if (watermark !== undefined && compareTs(entry.ts, watermark) <= 0) {
			this.replayedIgnoredCount += 1;
			return undefined;
		}
		this.retained.set(key, { ts: entry.ts, deleted: entry.deleted, doc: entry.doc });
		return entry.deleted ? [key, []] : [key, [entry.doc as Doc]];
	}

	get replayedIgnored(): number {
		return this.replayedIgnoredCount;
	}

	/**
	 * GC: sweeps retained tombstones at or under `horizonTs`, once the
	 * cursor has passed it. Each swept key leaves behind its low-watermark
	 * (the max swept `ts`), so a later replay at/under the watermark is
	 * still ignored as stale and can never resurrect the row. A malformed
	 * `horizonTs` throws an `Error`, never a raw `SyntaxError`.
	 */
	sweepTombstones(horizonTs: string | bigint): void {
		toBigInt(horizonTs, "as sweepTombstones horizonTs");
		for (const [key, revision] of this.retained) {
			if (revision.deleted && compareTs(revision.ts, horizonTs) <= 0) {
				this.retained.delete(key);
				const prev = this.watermarks.get(key);
				if (prev === undefined || compareTs(prev, revision.ts) < 0) {
					this.watermarks.set(key, revision.ts);
				}
			}
		}
	}

	get retainedSize(): number {
		return this.retained.size;
	}
}

export type ApplyResult<Doc extends Json> =
	| { readonly status: "applied"; readonly change: Entry<string, Doc> }
	| { readonly status: "replay-ignored" }
	| { readonly status: "late-generation-dropped" };

/**
 * Ties `RevisionDeltaApplier` (per-generation watermark/tombstone state)
 * to `GenerationManager` (fencing/staging/promotion): the source-facing
 * API a consumer like 1c's `data_sync_push` wires transport and lifecycle
 * around, rather than hand-building a second generation-fenced state
 * machine. A generation accepts writes only up to its one promotion;
 * ongoing delivery once already current is a consuming spike's own
 * integration (1c's U4), out of this unit's scope.
 *
 * Counter semantics (retained): `replayedIgnored(id)` is scoped to one
 * live generation -- `beginGeneration` discards prior appliers wholesale
 * on swap (P5), so querying a superseded id returns 0 rather than a
 * cumulative total. `lateEventDropCount` is cumulative across generations
 * and never reset. Stale `markGroupComplete` calls are counted as late
 * drops (retry-safe: marking an already-marked group is a no-op and still
 * returns `true`); only query-only checks (`isCurrentGeneration`,
 * `replayedIgnored`, `currentSnapshot`) never count.
 */
export class RevisionDeltaSource<Doc extends Json> {
	private readonly generations = new GenerationManager<string, Doc>();
	private readonly appliers = new Map<GenerationId, RevisionDeltaApplier<Doc>>();

	/** Begins a new generation (cold build or resnapshot), discarding any prior staging generation wholesale. */
	beginGeneration(): GenerationId {
		const id = this.generations.beginGeneration();
		this.appliers.clear(); // GC: discard wholesale on swap (P5).
		this.appliers.set(id, new RevisionDeltaApplier<Doc>());
		return id;
	}

	isCurrentGeneration(id: GenerationId): boolean {
		return this.generations.isCurrentGeneration(id);
	}

	/** Begins a new page within generation `id`, declaring its timestamp groups up front. `undefined` if `id` is stale. */
	beginPage(id: GenerationId, groupIds: readonly string[]): PendingPageLedger | undefined {
		return this.generations.stagingFor(id)?.beginPage(groupIds);
	}

	/**
	 * Applies one entry to a staging generation. Late (superseded generation) and replayed entries are reported
	 * distinctly, never applied twice. Throws, before touching any watermark, if `id` has already promoted: a
	 * watermark advanced for a revision that never reached the published snapshot would make its later replay
	 * look stale and drop it for good.
	 */
	applyEntry(id: GenerationId, entry: RevisionDeltaEntry<Doc>): ApplyResult<Doc> {
		const staging = this.generations.stagingFor(id);
		if (staging === undefined) return { status: "late-generation-dropped" };
		if (staging.isPromoted) {
			throw new Error(`applyEntry: generation ${id} has already promoted; it accepts no further staging writes`);
		}
		const applier = this.appliers.get(id);
		if (applier === undefined) return { status: "late-generation-dropped" };
		const change = applier.apply(entry);
		if (change === undefined) return { status: "replay-ignored" };
		staging.write(change[0], change[1]);
		return { status: "applied", change };
	}

	/**
	 * Marks `groupId` fully applied within `ledger`. A page's cursor is releasable only once every group is marked.
	 * Idempotent: re-marking an already-marked group is a no-op returning `true`. A stale `id` returns `false`
	 * and is counted as a late drop.
	 */
	markGroupComplete(id: GenerationId, ledger: PendingPageLedger, groupId: string): boolean {
		if (!this.isCurrentGeneration(id)) {
			this.generations.recordLateDrop();
			return false;
		}
		ledger.markGroupApplied(groupId);
		return true;
	}

	/** Atomically promotes generation `id` to current, once every page's ledger is complete. A stale `id` is dropped. Re-promoting the already-promoted current generation is idempotent. */
	promote(id: GenerationId): boolean {
		return this.generations.promote(id);
	}

	/**
	 * GC passthrough: sweeps generation `id`'s retained tombstones at or
	 * under `horizonTs`. Returns `false` (and sweeps nothing) if `id` is
	 * stale -- a query-only staleness check that is never counted as a
	 * late drop.
	 */
	sweepTombstones(id: GenerationId, horizonTs: string | bigint): boolean {
		if (!this.isCurrentGeneration(id)) return false;
		const applier = this.appliers.get(id);
		if (applier === undefined) return false;
		applier.sweepTombstones(horizonTs);
		return true;
	}

	get currentSnapshot(): ReadonlyMap<string, Doc[]> {
		return this.generations.currentSnapshot;
	}

	replayedIgnored(id: GenerationId): number {
		return this.appliers.get(id)?.replayedIgnored ?? 0;
	}

	get lateEventDropCount(): number {
		return this.generations.lateEventDropCount;
	}
}
