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
      throw new Error(
        "PendingPageLedger requires at least one group id (empty group list would complete immediately)",
      );
    }
    const unique = new Set(groupIds);
    if (unique.size !== groupIds.length) {
      throw new Error(
        "PendingPageLedger group ids must be unique (duplicate group id)",
      );
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
      throw new Error(
        `group "${groupId}" was never named in this page's ledger`,
      );
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

  /** `seed` pre-populates the build, e.g. a replacement candidate cloned from the last-good snapshot. */
  constructor(seed?: Iterable<readonly [K, readonly V[]]>) {
    if (seed !== undefined)
      for (const [key, values] of seed) this.rows.set(key, [...values]);
  }

  beginPage(groupIds: readonly string[]): PendingPageLedger {
    if (this.promoted)
      throw new Error(
        "cannot begin a page on a build that has already promoted",
      );
    const ledger = new PendingPageLedger(groupIds);
    this.pages.push(ledger);
    return ledger;
  }

  write(key: K, values: readonly V[]): void {
    if (this.promoted)
      throw new Error("cannot write to a staging build after it has promoted");
    this.rows.set(key, [...values]);
  }

  get isReadyToPromote(): boolean {
    return this.pages.every((page) => page.isComplete);
  }

  /**
   * Drops every page ledger that can no longer complete because its
   * connection ended mid-page, so the build can still promote once the
   * resent page arrives. Rows already written stay, and the resent page's
   * copies of them are ignored as replays. Returns the number dropped.
   */
  abandonIncompletePages(): number {
    const before = this.pages.length;
    const complete = this.pages.filter((page) => page.isComplete);
    this.pages.length = 0;
    this.pages.push(...complete);
    return before - complete.length;
  }

  /** Removes every row whose key matches `pred` (a table truncated mid-build). */
  deleteWhere(pred: (key: K) => boolean): void {
    if (this.promoted)
      throw new Error(
        "cannot delete from a staging build after it has promoted",
      );
    for (const key of [...this.rows.keys()])
      if (pred(key)) this.rows.delete(key);
  }

  /** Every row written so far, including tombstones (empty arrays). */
  entries(): IterableIterator<[K, readonly V[]]> {
    return this.rows.entries();
  }

  get isPromoted(): boolean {
    return this.promoted;
  }

  /** Atomically promotes this build to a settled snapshot, once. Throws if any page is still incomplete. */
  promote(): ReadonlyMap<K, V[]> {
    if (this.promoted) throw new Error("staging build already promoted");
    if (!this.isReadyToPromote) {
      throw new Error(
        "cannot promote: a page's pending ledger is still incomplete",
      );
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
  private current = new Map<K, V[]>();
  private staging: StagingBuild<K, V> | undefined;
  private stagingGenerationId = 0;
  private liveGenerationId: GenerationId | undefined;
  private lateEventsDropped = 0;

  /**
   * The published snapshot. Live writes (`writeLive`) update it in place so
   * each group costs O(changed keys); callers must not cache it expecting a
   * frozen view.
   */
  get currentSnapshot(): ReadonlyMap<K, V[]> {
    return this.current;
  }

  /** The promoted generation whose snapshot is published, or `undefined` before the first promotion. */
  get liveGeneration(): GenerationId | undefined {
    return this.liveGenerationId;
  }

  /** True when `id` has promoted and is still the single write target. */
  isLive(id: GenerationId): boolean {
    return id === this.liveGenerationId && this.isCurrentGeneration(id);
  }

  /**
   * Writes one row straight into the published snapshot of the live
   * generation `id` (ongoing CDC after promotion). An empty `values` deletes
   * the key; stored arrays are frozen like promoted ones. Returns `false`,
   * counting a late drop, when `id` is not the live write target.
   */
  writeLive(id: GenerationId, key: K, values: readonly V[]): boolean {
    if (!this.isLive(id)) {
      this.lateEventsDropped += 1;
      return false;
    }
    if (values.length === 0) {
      this.current.delete(key);
    } else {
      this.current.set(key, Object.freeze([...values]) as V[]);
    }
    return true;
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

  /**
   * Begins a replacement candidate seeded from the live snapshot's rows that
   * `retain` keeps (every table but the truncated ones). The candidate becomes
   * the single write target, so the live generation is fenced while it builds,
   * but its snapshot stays published until the candidate promotes. Any earlier
   * candidate is discarded. Throws if nothing is live yet.
   */
  beginReplacement(retain: (key: K) => boolean): GenerationId {
    if (this.liveGenerationId === undefined) {
      throw new Error(
        "beginReplacement requires a live generation; use beginGeneration for a cold build",
      );
    }
    this.currentGenerationId += 1;
    this.stagingGenerationId = this.currentGenerationId;
    this.staging = new StagingBuild<K, V>(
      [...this.current].filter(([key]) => retain(key)),
    );
    return this.stagingGenerationId;
  }

  /** The replacement or cold build still being staged, or `undefined` when the write target is live. */
  get candidateGeneration(): GenerationId | undefined {
    return this.staging === undefined || this.staging.isPromoted
      ? undefined
      : this.stagingGenerationId;
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
    // Tombstoned keys (empty arrays) are not part of the published snapshot.
    this.current = new Map(
      [...staging.promote()].filter(([, values]) => values.length > 0),
    );
    this.liveGenerationId = id;
    return true;
  }
}
