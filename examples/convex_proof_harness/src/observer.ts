/**
 * Q14's no-torn observer (AE13): detects any published intermediate state
 * of a named atomic group, in either write order. Subscribes through the
 * SSE reader (sse_reader.ts) and records every published state on the
 * group's watched keys, keyed by its `id:` watermark; a torn state is any
 * published state equal to neither the group's pre-state nor its
 * post-state.
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U9,
 * Q14, AE13.
 */

import type { Entry } from "./sse_reader.js";
import { HarnessError } from "./readiness.js";
import { deepEqual } from "./deep_equal.js";

/**
 * One atomic group to watch: a resource name plus the pre- and post-state
 * values of its watched keys, e.g. U3's `groupProbe`: pre
 * `{active: true, likeCount: 1}`, post `{active: false, likeCount: 2}`.
 */
export type WatchedGroup = {
	readonly resource: string;
	readonly pre: Readonly<Record<string, unknown>>;
	readonly post: Readonly<Record<string, unknown>>;
};

export type TornObservation = {
	readonly watermark: string;
	readonly state: Readonly<Record<string, unknown>>;
};

/**
 * Every single-field-first partial state reachable by changing exactly one
 * of the group's watched fields to its `post` value while the rest stay at
 * `pre`. For a two-field probe this is exactly the two write orders'
 * intermediate states; for V6's groupProbe that is the membership-first tear
 * (`{active: false, likeCount: 1}`) and the likes-first tear
 * (`{active: true, likeCount: 2}`). Only two-field groups are supported
 * (see NoTornObserver): the field list is the union of `pre`'s and `post`'s
 * keys, with a missing side treated as `undefined`, so an added or removed
 * key counts as a changed field.
 */
function unionChangedFields(
	pre: Readonly<Record<string, unknown>>,
	post: Readonly<Record<string, unknown>>,
): string[] {
	const fields = new Set([...Object.keys(pre), ...Object.keys(post)]);
	return [...fields].filter((field) => !deepEqual(pre[field], post[field]));
}

function computeHalfTornStates(
	pre: Readonly<Record<string, unknown>>,
	post: Readonly<Record<string, unknown>>,
): Record<string, unknown>[] {
	return unionChangedFields(pre, post).map((field) => {
		const state = { ...pre };
		if (Object.prototype.hasOwnProperty.call(post, field)) {
			state[field] = post[field];
		} else {
			delete state[field];
		}
		return state;
	});
}

/**
 * Watches one atomic group and reports every published state that is
 * neither its pre-state nor its post-state. Only two-field groups are
 * supported: the two single-field-first partials are exactly the two write
 * orders' intermediate states, which is what lets construction prove the
 * group can tell both orders apart. Refuses, as a harness error at
 * construction time, a group that could never prove anything: pre and post
 * equal, a group whose changed-field count is not exactly two (a single
 * changed field's partial *is* its post-state; three or more changed
 * fields have multi-field partials this observer does not enumerate), a
 * single-field partial that already equals pre or post (a group
 * that cannot tell both write orders apart), or a resource the consumer
 * service under test does not serve.
 *
 * Single-transition use only: one instance watches one pre-to-post
 * transition. Reuse across successive transitions would false-positive on
 * the next legitimate state, so create a fresh observer per transition.
 */
export class NoTornObserver {
	private readonly halfTornStates: readonly Record<string, unknown>[];
	private readonly torn: TornObservation[] = [];

	constructor(
		private readonly group: WatchedGroup,
		servedResources: readonly string[],
	) {
		if (!servedResources.includes(group.resource)) {
			throw new HarnessError(
				`watched resource "${group.resource}" is not served by the consumer service under test`,
			);
		}
		if (deepEqual(group.pre, group.post)) {
			throw new HarnessError(
				`watched group "${group.resource}": pre-state and post-state are equal; cannot prove atomicity`,
			);
		}
		const halfTornStates = computeHalfTornStates(group.pre, group.post);
		if (halfTornStates.length !== 2) {
			throw new HarnessError(
				`watched group "${group.resource}": expected exactly two changed fields, found ` +
					`${halfTornStates.length}; this observer only supports two-field groups whose ` +
					`single-field partials are exactly the two write orders' intermediate states`,
			);
		}
		for (const state of halfTornStates) {
			if (deepEqual(state, group.pre) || deepEqual(state, group.post)) {
				throw new HarnessError(
					`watched group "${group.resource}": a single-field partial state equals its pre- or ` +
						`post-state; this group cannot tell both write orders apart`,
				);
			}
		}
		this.halfTornStates = halfTornStates;
	}

	/** The computed intermediate states this group's construction proved distinguishable. */
	get expectedHalfTornStates(): readonly Record<string, unknown>[] {
		return this.halfTornStates;
	}

	/**
	 * Records one published state for the watched group. `state` is
	 * `undefined` for an unrelated key, a heartbeat, or any update this
	 * group's keys are not part of -- ignored, never a false positive.
	 */
	observe(watermark: string, state: Record<string, unknown> | undefined): void {
		if (state === undefined) return;
		if (deepEqual(state, this.group.pre) || deepEqual(state, this.group.post)) return;
		this.torn.push({ watermark, state });
	}

	get tornEvents(): readonly TornObservation[] {
		return this.torn;
	}

	get passed(): boolean {
		return this.torn.length === 0;
	}
}

/**
 * Extracts the watched key's current value from one SSE update's raw
 * `Entry<K,V>[]` (an empty `values` array is a deletion, reported as
 * `undefined`; an absent key is also `undefined`, both ignored by
 * `observe`).
 */
export function extractWatchedValue(entries: readonly Entry[], key: unknown): Record<string, unknown> | undefined {
	for (const [entryKey, values] of entries) {
		if (deepEqual(entryKey, key)) {
			return values.length === 0 ? undefined : (values[values.length - 1] as Record<string, unknown>);
		}
	}
	return undefined;
}
