/**
 * The shared publication-state vocabulary (research-publication-state-
 * semantics.md), standardized across directions without standardizing
 * implementations. The invariant every fault injector must uphold: never
 * publish a partial result as `current`.
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U10,
 * Q6.
 */

export type PublicationState =
	| "not-yet-loaded"
	| "frozen"
	| "blank"
	| "current"
	| "comparison-ready"
	| "removed"
	| "terminal";

/** States a snapshot-path baseline fault is ever allowed to expect (never a partial `current`). */
export type BaselineExpectedState = "not-yet-loaded" | "frozen" | "blank";
