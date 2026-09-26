/**
 * P9's generation-fencing and replay-safety primitives: a staging
 * generation for cold/replacement builds, atomic promotion of a complete
 * candidate, and a per-page pending ledger that withholds cursor
 * advancement until every timestamp group in a page succeeds. Matches the
 * bar 1c's KTD7/KTD9 design sets and the generation-fencing pattern in
 * `skip: skipruntime-ts/adapters/convex/src/index.ts:249-332`.
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U13,
 * P9.
 */

export type GenerationId = number;

/**
 * Tracks one page's timestamp groups until every one of them has
 * succeeded. The cursor for this page may only advance once
 * `isComplete` is true -- P4's "cursors/watermarks advance only after the
 * entire group succeeds," extended to every group in the page.
 */
export class PendingPageLedger {
	private readonly pending: Set<string>;
	private readonly known: Set<string>;

	constructor(groupIds: readonly string[]) {
		if (groupIds.length === 0) {
			throw new Error("PendingPageLedger requires at least one group id (empty group list would complete immediately)");
		}
		const unique = new Set(groupIds);
		if (unique.size !== groupIds.length) {
			throw new Error("PendingPageLedger group ids must be unique (duplicate group id)");
		}
		this.pending = unique;
		this.known = new Set(unique);
	}

	/**
	 * Marks `groupId` applied. Idempotent: re-marking an already-applied
	 * (known) group is a no-op, matching the idempotent entry-application
	 * contract. Marking a group id that was never named still throws.
	 */
	markGroupApplied(groupId: string): void {
		if (!this.known.has(groupId)) {
			throw new Error(`group "${groupId}" was never named in this page's ledger`);
		}
		this.pending.delete(groupId);
	}

	get isComplete(): boolean {
		return this.pending.size === 0;
	}

	get remainingGroups(): readonly string[] {
		return [...this.pending];
	}
}

/**
 * Accumulates a cold-build or replacement candidate across one or more
 * pages, publishing nothing partial: `promote()` is the one point where
 * this build's rows become visible, and only once every page's ledger is
 * complete.
 */
export class StagingBuild<K, V> {
	private readonly rows = new Map<K, V[]>();
	private readonly pages: PendingPageLedger[] = [];
	private promoted = false;

	beginPage(groupIds: readonly string[]): PendingPageLedger {
		if (this.promoted) throw new Error("cannot begin a page on a build that has already promoted");
		const ledger = new PendingPageLedger(groupIds);
		this.pages.push(ledger);
		return ledger;
	}

	write(key: K, values: readonly V[]): void {
		if (this.promoted) throw new Error("cannot write to a staging build after it has promoted");
		this.rows.set(key, [...values]);
	}

	get isReadyToPromote(): boolean {
		return this.pages.every((page) => page.isComplete);
	}

	get isPromoted(): boolean {
		return this.promoted;
	}

	/** Atomically promotes this build to a settled snapshot, once. Throws if any page is still incomplete. */
	promote(): ReadonlyMap<K, V[]> {
		if (this.promoted) throw new Error("staging build already promoted");
		if (!this.isReadyToPromote) {
			throw new Error("cannot promote: a page's pending ledger is still incomplete");
		}
		this.promoted = true;
		// Freeze each published array so a caller holding a snapshot
		// reference cannot silently corrupt promoted state in place; a
		// mutating call then throws loudly instead. `write` already stores
		// a fresh copy, so freezing here never freezes a caller-owned array.
		for (const values of this.rows.values()) Object.freeze(values);
		return new Map(this.rows);
	}
}

/**
 * Generation fencing: only one generation is ever the active staging
 * generation. Beginning a new one discards the previous staging build
 * wholesale (GC on swap, P5) and fences out any event still arriving for
 * the superseded generation -- a late event is dropped, not applied,
 * and counted.
 *
 * Counter semantics: `lateEventsDropped` counts verified dropped events
 * only (a stale `stagingFor`/`promote`/`beginPage` call, or an explicitly
 * recorded late mark via `recordLateDrop`). Query-only staleness checks
 * (`isCurrentGeneration`, `lateEventDropCount`, `currentSnapshot`,
 * `generation`) never increment it. The counter is cumulative across
 * generations and is never reset by `beginGeneration`.
 */
export class GenerationManager<K, V> {
	private currentGenerationId = 0;
	private current: ReadonlyMap<K, V[]> = new Map();
	private staging: StagingBuild<K, V> | undefined;
	private stagingGenerationId = 0;
	private lateEventsDropped = 0;

	get currentSnapshot(): ReadonlyMap<K, V[]> {
		return this.current;
	}

	get generation(): GenerationId {
		return this.currentGenerationId;
	}

	get lateEventDropCount(): number {
		return this.lateEventsDropped;
	}

	/**
	 * Records one verified late event that has no `stagingFor` call site
	 * of its own (e.g. a stale mark-group-complete, which checks
	 * `isCurrentGeneration` -- a query that must not itself count).
	 */
	recordLateDrop(): void {
		this.lateEventsDropped += 1;
	}

	/** Begins a new staging generation, discarding any prior staging build wholesale. */
	beginGeneration(): GenerationId {
		this.currentGenerationId += 1;
		this.stagingGenerationId = this.currentGenerationId;
		this.staging = new StagingBuild<K, V>();
		return this.stagingGenerationId;
	}

	isCurrentGeneration(id: GenerationId): boolean {
		return id === this.stagingGenerationId;
	}

	/**
	 * The active staging build for `id`, or `undefined` if `id` has been
	 * superseded (a late event, counted and dropped by the caller rather
	 * than applied).
	 */
	stagingFor(id: GenerationId): StagingBuild<K, V> | undefined {
		if (!this.isCurrentGeneration(id)) {
			this.lateEventsDropped += 1;
			return undefined;
		}
		return this.staging;
	}

	/**
	 * Atomically promotes generation `id`'s staging build to current. A
	 * stale `id` is dropped, never applied. Idempotent: re-promoting the
	 * already-promoted current generation returns `true` (the at-least-
	 * once cursor-commit retry path) instead of throwing.
	 */
	promote(id: GenerationId): boolean {
		const staging = this.stagingFor(id);
		if (staging === undefined) return false;
		if (staging.isPromoted) return true;
		this.current = staging.promote();
		return true;
	}
}
