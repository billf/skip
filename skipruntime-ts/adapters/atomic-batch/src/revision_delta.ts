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
import { GenerationManager, PendingPageLedger, type GenerationId } from "./generation.js";

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

/**
 * The key a revision-delta source publishes for one document:
 * `component \0 table \0 _id`. NUL never appears in a component path, table
 * name, or document id, so the key cannot collide even for nested component
 * paths (unlike `namespacedKey`'s `/` separator).
 */
export function revisionKey(ref: { component: string; table: string; _id: string }): string {
	return `${ref.component}\u0000${ref.table}\u0000${ref._id}`;
}

/**
 * One batch of entries validated and resolved against an applier's state
 * without changing it. `commit` applies it; dropping it applies nothing.
 */
export type PreparedRevisions<Doc extends Json> = {
	/** One change per touched key, in first-touched order; an empty array is a tombstone. */
	readonly changes: Entry<string, Doc>[];
	/** Entries ignored as replays at or under a retained ts or swept watermark. */
	readonly ignored: number;
	readonly retain: ReadonlyMap<string, RetainedRevision<Doc>>;
};

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
		const prepared = this.prepare([entry]);
		this.commit(prepared);
		return prepared.changes[0];
	}

	/**
	 * Validates and resolves a batch (one timestamp group) against this
	 * applier's watermarks without changing anything. A later entry for the
	 * same key in the batch is compared against the earlier one. The two-phase
	 * split lets a live caller hand the changes to Skip first and `commit` only
	 * once Skip accepted them, so a watermark never runs ahead of what was
	 * published. Throws on an invalid entry before resolving any of the batch.
	 */
	prepare(entries: readonly RevisionDeltaEntry<Doc>[]): PreparedRevisions<Doc> {
		const retain = new Map<string, RetainedRevision<Doc>>();
		const changes = new Map<string, Doc[]>();
		let ignored = 0;
		for (const entry of entries) {
			const key = revisionKey(entry);
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
			const prior = retain.get(key) ?? this.retained.get(key);
			if (prior !== undefined && compareTs(entry.ts, prior.ts) <= 0) {
				ignored += 1;
				continue;
			}
			const watermark = this.watermarks.get(key);
			if (watermark !== undefined && compareTs(entry.ts, watermark) <= 0) {
				ignored += 1;
				continue;
			}
			retain.set(key, { ts: entry.ts, deleted: entry.deleted, doc: entry.doc });
			changes.set(key, entry.deleted ? [] : [entry.doc as Doc]);
		}
		return { changes: [...changes], ignored, retain };
	}

	/** Applies a batch `prepare` resolved: retains its revisions and counts its replays. */
	commit(prepared: PreparedRevisions<Doc>): void {
		for (const [key, revision] of prepared.retain) this.retained.set(key, revision);
		this.replayedIgnoredCount += prepared.ignored;
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

export type ApplyGroupResult<Doc extends Json> =
	| { readonly status: "applied"; readonly changes: Entry<string, Doc>[]; readonly replayIgnored: number }
	| { readonly status: "late-generation-dropped" };

/** Hands Skip one atomic update; resolves once Skip accepted it. */
export type Publish<Doc extends Json> = (changes: Entry<string, Doc>[]) => Promise<void>;

/**
 * Ties `RevisionDeltaApplier` (per-generation watermark/tombstone state)
 * to `GenerationManager` (fencing/staging/promotion): the source-facing
 * API a consumer like 1c's `data_sync_push` wires transport and lifecycle
 * around, rather than hand-building a second generation-fenced state
 * machine. A generation stages writes (`applyEntry`/`applyGroup`) until
 * its one promotion; after that, `applyGroup` delivers ongoing CDC straight
 * into the live snapshot, committing each group only once its `publish`
 * callback (one Skip update) has resolved.
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

	/** True when `id` has promoted and is still the write target, so `applyGroup` delivers into the live snapshot. */
	isLive(id: GenerationId): boolean {
		return this.generations.isLive(id);
	}

	get liveGeneration(): GenerationId | undefined {
		return this.generations.liveGeneration;
	}

	/**
	 * Begins a new page within generation `id`, declaring its timestamp groups up front. `undefined` if `id` is stale.
	 * On the live generation the ledger is not tracked by the (already promoted) build; it only gates the page's
	 * cursor checkpoint. A page with no values needs no ledger at all (a ledger rejects an empty group list).
	 */
	beginPage(id: GenerationId, groupIds: readonly string[]): PendingPageLedger | undefined {
		const staging = this.generations.stagingFor(id);
		if (staging === undefined) return undefined;
		return staging.isPromoted ? new PendingPageLedger(groupIds) : staging.beginPage(groupIds);
	}

	/**
	 * Applies one timestamp group (one Convex transaction) and marks it in `ledger`.
	 *
	 * On a staging generation the group's changes go into the candidate and nothing is published. On the live
	 * generation the changes are handed to `publish` as one atomic Skip update; the watermarks, the live snapshot,
	 * and the ledger change only after it resolves. If `publish` rejects, nothing is committed and the error is
	 * rethrown, so the same group applies again on retry. `publish` is called only when the group has changes.
	 */
	async applyGroup(
		id: GenerationId,
		ledger: PendingPageLedger,
		groupId: string,
		entries: readonly RevisionDeltaEntry<Doc>[],
		publish?: Publish<Doc>,
	): Promise<ApplyGroupResult<Doc>> {
		const staging = this.generations.stagingFor(id);
		const applier = this.appliers.get(id);
		if (staging === undefined || applier === undefined) return { status: "late-generation-dropped" };
		const prepared = applier.prepare(entries);
		if (!staging.isPromoted) {
			applier.commit(prepared);
			for (const [key, values] of prepared.changes) staging.write(key, values);
			ledger.markGroupApplied(groupId);
			return { status: "applied", changes: prepared.changes, replayIgnored: prepared.ignored };
		}
		if (prepared.changes.length > 0) {
			if (publish === undefined) {
				throw new Error(`applyGroup: generation ${id} is live; its changes need a publish callback`);
			}
			await publish(prepared.changes);
			if (!this.isLive(id)) {
				// Superseded while Skip applied the update: the new generation owns state from here on.
				this.generations.recordLateDrop();
				return { status: "late-generation-dropped" };
			}
		}
		applier.commit(prepared);
		for (const [key, values] of prepared.changes) this.generations.writeLive(id, key, values);
		ledger.markGroupApplied(groupId);
		return { status: "applied", changes: prepared.changes, replayIgnored: prepared.ignored };
	}

	/**
	 * Drops page ledgers that a lost connection left incomplete, so the build can still promote after the page is
	 * resent. Returns `false` (counted as a late drop) for a stale `id`; the live generation tracks no ledgers.
	 */
	abandonIncompletePages(id: GenerationId): boolean {
		const staging = this.generations.stagingFor(id);
		if (staging === undefined) return false;
		if (!staging.isPromoted) staging.abandonIncompletePages();
		return true;
	}

	/**
	 * Every non-empty row of generation `id`: the candidate before promotion, the live snapshot after.
	 * `undefined` if `id` is not the write target (query-only; never counted).
	 */
	stateEntries(id: GenerationId): Entry<string, Doc>[] | undefined {
		if (!this.isCurrentGeneration(id)) return undefined;
		if (this.isLive(id)) return [...this.currentSnapshot].map(([key, values]) => [key, [...values]]);
		const staging = this.generations.stagingFor(id);
		if (staging === undefined) return undefined;
		const rows: Entry<string, Doc>[] = [];
		for (const [key, values] of staging.entries()) {
			if (values.length > 0) rows.push([key, [...values]]);
		}
		return rows;
	}

	/**
	 * Publishes generation `id`'s whole candidate in one `publish` call (one Skip `isInit` update), then promotes it.
	 * If `publish` rejects, nothing changes and a retry works. Re-promoting the already-live generation is
	 * idempotent and publishes nothing. Throws, before publishing, if a page ledger is still incomplete.
	 */
	async promoteWith(id: GenerationId, publish: Publish<Doc>): Promise<boolean> {
		const staging = this.generations.stagingFor(id);
		if (staging === undefined) return false;
		if (staging.isPromoted) return true;
		if (!staging.isReadyToPromote) {
			throw new Error("cannot promote: a page's pending ledger is still incomplete");
		}
		await publish(this.stateEntries(id) ?? []);
		if (!this.isCurrentGeneration(id)) {
			this.generations.recordLateDrop();
			return false;
		}
		return this.promote(id);
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
		const promoted = this.generations.promote(id);
		if (promoted) {
			// Only the promoted generation's watermarks matter from here on.
			for (const other of [...this.appliers.keys()]) if (other !== id) this.appliers.delete(other);
		}
		return promoted;
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

	/** Revisions (including unswept tombstones) generation `id` retains for replay protection. */
	retainedSize(id: GenerationId): number {
		return this.appliers.get(id)?.retainedSize ?? 0;
	}

	get lateEventDropCount(): number {
		return this.generations.lateEventDropCount;
	}
}
