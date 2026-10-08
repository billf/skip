/**
 * Q6's snapshot-path baseline fault injectors and Q7's reusable
 * detection/recovery/count assertions. An injector exposes only
 * `{trigger(), expectedState, counterName}`; a consuming spike supplies
 * its own `trigger` (how to force a disconnect, a QueryFailed, etc.) and
 * reuses everything else.
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U10,
 * Q6, Q7, AE5.
 */

import { HarnessError } from "../readiness.js";
import type { BaselineExpectedState, PublicationState } from "./state.js";

/** A fault's trigger; returning exactly `false` declares a no-op (see `FaultInjector.trigger`). */
export type FaultTrigger = () => void | boolean | Promise<void | boolean>;

export type FaultInjector = {
	readonly name: string;
	readonly counterName: string;
	readonly expectedState: BaselineExpectedState;
	/**
	 * Forces the fault. Returning exactly `false` declares "no fault was
	 * actually injected" (a no-op trigger); `run()` then fails closed
	 * without incrementing the fault's counter, so counters record
	 * verified fault occurrences, not trigger attempts. Any other return
	 * (including `void`) means the fault was injected.
	 */
	trigger: FaultTrigger;
};

/**
 * Produces the publication state observed *after* `run()` resolves the
 * injector's `trigger()`. `run()` invokes this getter only after
 * `trigger()` settles, so detection always compares post-trigger state --
 * never a value computed by the caller before `run()` was called (JS
 * evaluates call arguments before the callee body runs, so a
 * pre-computed value argument could only ever be pre-trigger state).
 */
export type ObservePublicationState = () => PublicationState | Promise<PublicationState>;

/**
 * Receipt for one successful `run()` detection. `assertRecovered`
 * requires the receipt returned by the `run()` it follows, which ties
 * recovery to a specific prior run and makes the must-not-call rules
 * structural: with no preceding successful `run()` there is no receipt
 * to pass, a fabricated receipt is rejected, and an unknown-event
 * suspension (which throws out of `run()`) issues no receipt.
 */
export type FaultCheckpoint = {
	readonly injectorName: string;
	readonly runSequence: number;
};

export class FaultAssertionError extends HarnessError {}

/** Disconnect before a checkpoint, then reconnect: the last-good result freezes until recovery. */
export function disconnectBeforeCheckpointFault(trigger: FaultTrigger): FaultInjector {
	return { name: "disconnect-before-checkpoint", counterName: "reconnects", expectedState: "frozen", trigger };
}

/**
 * `QueryFailed`: query-subscription sources only (1a, 1b). 1c's Data Sync
 * source emits document revisions, not reactive query results, so it has
 * no trigger for this and the baseline's query-state faults do not apply
 * to it.
 */
export function queryFailedFault(trigger: FaultTrigger): FaultInjector {
	return { name: "query-failed", counterName: "queryFailed", expectedState: "frozen", trigger };
}

/** `QueryRemoved`: intentional unsubscribe/removal, not a failure -- the result empties, never freezes stale. */
export function queryRemovedFault(trigger: FaultTrigger): FaultInjector {
	return { name: "query-removed", counterName: "queryRemoved", expectedState: "blank", trigger };
}

/** A query with no prior good result yet: nothing to freeze, so `not-yet-loaded`, never blank-as-current. */
export function notYetLoadedFault(trigger: FaultTrigger): FaultInjector {
	return { name: "not-yet-loaded", counterName: "notYetLoaded", expectedState: "not-yet-loaded", trigger };
}

/**
 * A write spanning multiple tables applied as one atomic unit: no torn
 * intermediate publishes as current.
 *
 * Timing semantics under `run()`'s post-trigger observation contract: the
 * observer runs immediately after `trigger()` resolves, so the observed
 * state is the *intermediate* post-trigger state, expected `"frozen"` (no
 * torn publish as current while the atomic unit is in flight). A complete
 * post-transaction `"current"` observed after the transaction settles is
 * legitimate and out of scope for `run()` -- assert that settled state
 * via `assertRecovered` at the next checkpoint, not via `run()`.
 */
export function multiTableTransactionFault(trigger: FaultTrigger): FaultInjector {
	return {
		name: "multi-table-transaction",
		counterName: "atomicBatches",
		expectedState: "frozen",
		trigger,
	};
}

/**
 * Slow consumer / bounded-backlog exhaustion. Whether this should be
 * `frozen` (1b/1c-style stale) or a D2-style fallback is an open question
 * in research-publication-state-semantics.md; this baseline picks the
 * conservative default (`frozen`, matching the disconnect fault) and
 * flags it here so a resolution to that open question can update it in
 * one place.
 */
export function slowConsumerBacklogExhaustionFault(trigger: FaultTrigger): FaultInjector {
	return {
		name: "slow-consumer-backlog-exhaustion",
		counterName: "backlogExhaustion",
		expectedState: "frozen",
		trigger,
	};
}

class FaultCounters {
	private readonly counts = new Map<string, number>();

	increment(name: string): void {
		this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
	}

	count(name: string): number {
		return this.counts.get(name) ?? 0;
	}
}

/**
 * Runs one fault, asserting detection (never partial-as-current), and
 * separately asserting recovery-to-a-match and the fault's count -- all
 * independent of which spike's source produced the fault.
 */
export class FaultHarness {
	private readonly counters = new FaultCounters();
	private readonly issuedCheckpoints = new Set<string>();
	private readonly latestSequenceByInjector = new Map<string, number>();
	private nextSequence = 1;

	private checkpointKey(checkpoint: FaultCheckpoint): string {
		return `${checkpoint.injectorName}:${checkpoint.runSequence}`;
	}

	/**
	 * Triggers `injector`, then invokes `observeState` and checks the
	 * post-trigger state it returns against the injector's expected state.
	 * `observeState` runs only after `trigger()` settles, so detection
	 * compares state observed after the fault fires. A trigger returning
	 * exactly `false` declares no fault was injected: `run()` fails closed
	 * (no counter increment, no checkpoint issued).
	 *
	 * `unknownEventsSinceLastCheckpoint` (default 0) is the SSE reader's
	 * unknown-event count spanning this fault's window: when nonzero, the
	 * checkpoint fails closed as a harness error (recovery assertion
	 * suspended, no checkpoint issued) rather than as a fault pass or
	 * fail, though the fault's own counter still increments (the fault
	 * did happen; only the *comparison* is compromised).
	 *
	 * WARNING: the default 0 means a caller that forgets to wire the real
	 * SSE reader's count silently downgrades an unknown-event window to a
	 * clean comparison. Always pass the live count; omit it only for
	 * synthetic unit tests.
	 *
	 * Ordering note: the unknown-event suspension is checked before the
	 * partial-as-current comparison, so a checkpoint spanning both shows
	 * the suspension error, not the fault failure. This matches the
	 * docstring contract (suspended comparison reports harness state,
	 * never a fault verdict).
	 *
	 * Returns the checkpoint receipt to pass to `assertRecovered`.
	 */
	async run(
		injector: FaultInjector,
		observeState: ObservePublicationState,
		unknownEventsSinceLastCheckpoint = 0,
	): Promise<FaultCheckpoint> {
		const injected = await injector.trigger();
		if (injected === false) {
			throw new FaultAssertionError(
				`fault "${injector.name}" trigger reported no fault injected; nothing to detect`,
			);
		}
		const observedState = await observeState();
		this.counters.increment(injector.counterName);

		if (unknownEventsSinceLastCheckpoint > 0) {
			throw new HarnessError(
				`checkpoint spanning fault "${injector.name}" saw ${unknownEventsSinceLastCheckpoint} ` +
					`unknown SSE event(s); recovery assertion suspended, checkpoint is a harness error`,
			);
		}

		if (observedState !== injector.expectedState) {
			if (observedState === "current" || observedState === "comparison-ready") {
				throw new FaultAssertionError(
					`fault "${injector.name}" published "${observedState}" with a partial result; expected ` +
						`"${injector.expectedState}"`,
				);
			}
			throw new FaultAssertionError(
				`fault "${injector.name}" expected state "${injector.expectedState}", observed "${observedState}"`,
			);
		}

		const checkpoint: FaultCheckpoint = { injectorName: injector.name, runSequence: this.nextSequence++ };
		this.issuedCheckpoints.add(this.checkpointKey(checkpoint));
		this.latestSequenceByInjector.set(injector.name, checkpoint.runSequence);
		return checkpoint;
	}

	/**
	 * Asserts the harness recorded a match at the next checkpoint after
	 * recovery. `checkpoint` must be the receipt returned by the `run()`
	 * this recovery follows, for the same injector, unconsumed by a prior
	 * successful `assertRecovered`, and still the latest run for that
	 * injector. Must-not-call rules (enforced, not just documented): no
	 * preceding successful `run()` (no receipt exists), a fabricated or
	 * cross-injector receipt, a receipt already consumed by a passing
	 * recovery assertion, a stale receipt superseded by a later `run()`,
	 * or any call after an unknown-event suspension (which issues no
	 * receipt) all throw instead of passing vacuously.
	 */
	assertRecovered(
		injector: FaultInjector,
		checkpoint: FaultCheckpoint,
		matchedAtNextCheckpoint: boolean,
	): void {
		const key = this.checkpointKey(checkpoint);
		const latest = this.latestSequenceByInjector.get(injector.name);
		if (
			checkpoint.injectorName !== injector.name ||
			!this.issuedCheckpoints.has(key) ||
			checkpoint.runSequence !== latest
		) {
			throw new FaultAssertionError(
				`fault "${injector.name}" has no matching successful run for this checkpoint; ` +
					`assertRecovered requires the checkpoint returned by run() for the same injector`,
			);
		}
		if (!matchedAtNextCheckpoint) {
			throw new FaultAssertionError(`fault "${injector.name}" did not recover to a match at the next checkpoint`);
		}
		this.issuedCheckpoints.delete(key);
	}

	/** Asserts `injector`'s counter recorded exactly `expected` occurrences. */
	assertCount(injector: FaultInjector, expected: number): void {
		const actual = this.counters.count(injector.counterName);
		if (actual !== expected) {
			throw new FaultAssertionError(
				`fault counter "${injector.counterName}" expected ${expected}, got ${actual}`,
			);
		}
	}
}
