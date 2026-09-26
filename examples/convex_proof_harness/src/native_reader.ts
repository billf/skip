/**
 * The independent native reader (Q2/KTD4): admits or rejects one
 * `ConvexClient` one-shot read sample against Q1's target revision. The
 * actual `ConvexClient` wiring (subscribe, take first result, unsubscribe,
 * record the client's transition timestamp) is a live-deployment concern
 * deferred to U11's reference service, matching U3's live same-tick
 * scenario and U5's loader CLI, neither of which this environment has a
 * deployment to verify against. What is not deferred, and is exercised
 * here, is the admission rule itself: this is Q's actual value-add over
 * "just call ConvexClient", and it is pure and fully testable without a
 * server.
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U8,
 * Q2, KTD4.
 */

export type NativeReadResult = {
	/** The reading client's transition timestamp when this one-shot read returned. */
	readonly version: number;
	readonly value: unknown;
};

export type NativeReadAdmission =
	| { readonly kind: "admitted"; readonly version: number; readonly value: unknown }
	| { readonly kind: "incomparable"; readonly reason: string };

/**
 * A sample is admitted only when its version is at or past `targetVersion`
 * and no harness mutation committed after the target mutation before this
 * read returned. Any other sample is incomparable -- never recorded as a
 * Skip mismatch.
 */
export function admitNativeSample(
	read: NativeReadResult,
	targetVersion: number,
	latestMutationCommitBeforeReadReturned: number | undefined,
): NativeReadAdmission {
	if (read.version < targetVersion) {
		return {
			kind: "incomparable",
			reason: `native read version ${read.version} precedes target version ${targetVersion}`,
		};
	}
	if (latestMutationCommitBeforeReadReturned !== undefined && latestMutationCommitBeforeReadReturned > targetVersion) {
		return {
			kind: "incomparable",
			reason:
				`a mutation committed at ${latestMutationCommitBeforeReadReturned}, after the target ` +
				`mutation, before the native read returned`,
		};
	}
	return { kind: "admitted", version: read.version, value: read.value };
}

/** A caller-supplied one-shot read, decoupled from any particular Convex client wiring. */
export type OneShotReader = {
	read(): Promise<NativeReadResult>;
};

/**
 * Wraps a caller-supplied one-shot reader with the admission rule. The
 * caller is responsible for the subscribe/take-first-result/unsubscribe
 * dance against a client that holds no standing subscription to the
 * compared query and args (KTD4) -- that dance needs a real
 * `ConvexClient`, so it lives in whichever consumer wires this reader to
 * one (1a/1b/1c's harness invocation, or U11's reference service, which
 * will supply the live latest-committed-mutation value).
 *
 * `getLatestMutationCommit` is invoked only after the one-shot `read()`
 * resolves, so a mutation that commits while the read is in flight is
 * observed and forces the sample to incomparable. Passing a value captured
 * before the read would structurally miss that race, so the post-await
 * getter -- not a pre-bound number -- is the only accepted shape.
 */
export class NativeReader {
	constructor(private readonly reader: OneShotReader) {}

	async sampleAtOrPast(
		targetVersion: number,
		getLatestMutationCommit: () => number | undefined,
	): Promise<NativeReadAdmission> {
		const result = await this.reader.read();
		return admitNativeSample(result, targetVersion, getLatestMutationCommit());
	}
}
