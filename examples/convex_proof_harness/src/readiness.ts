/**
 * Q1's readiness detector: gates one (source group applied) and two
 * (derived result published) only. It never reads the native oracle (gate
 * three is Q2's) and never records freshness (gate four is Q5's).
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U7,
 * Q1, Q12, KTD4.
 */

export class HarnessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HarnessError";
	}
}

export type Discipline = "quiesced" | "revision-tagged";

/**
 * Gate 1 evidence. `source-version` is the same-session case: the writer's
 * own `Transition.end_version.ts` (or `UpToDate(ts)`/page-set version) is
 * directly comparable to the required version. `source-marker` is the
 * cross-session case (KTD4): a source that reads on a different session
 * from the one issuing writes cannot use the writer's timestamps, so it
 * instead watches `proofVehicle/tables:markers` and gate 1 fires on the
 * first source transition whose observed marker sequence is at or past the
 * ack the harness's `fixture:marker` mutation returned.
 */
export type Gate1Event =
	| { readonly kind: "source-version"; readonly ts: number }
	| { readonly kind: "source-marker"; readonly ackSeq: number; readonly observedSeq: number; readonly ts: number };

/**
 * The caller-supplied version stream gate 2 watches. Heartbeats and empty
 * updates never carry a version and must never advance readiness; only a
 * `checkpoint` event (KTD4's checkpoint emitter, or a real feed update
 * inspected for its carried version) can.
 */
export type Gate2Event =
	| { readonly kind: "heartbeat" }
	| { readonly kind: "empty-update" }
	| { readonly kind: "checkpoint"; readonly version: number };

/**
 * Owns gates 1 and 2 for one required version, under one discipline.
 * Quiesced: the harness coordinator holds new writes until this detector
 * reports both gates (and Q2 reports gate 3). Revision-tagged: both readers
 * are compared at the same workload revision instead: gate 2 latches only
 * on the checkpoint carrying exactly the required revision, and any other
 * revision (earlier or later) arriving without the required one never
 * settles gate 2. An earlier revision arriving after a later one has
 * already been seen is ignored rather than regressing gate 2.
 */
export class ReadinessDetector {
	private gate1Version: number | undefined;
	private gate2Version: number | undefined;
	private highestRevisionSeen: number | undefined;

	constructor(
		private readonly discipline: Discipline,
		private readonly requiredVersion: number,
	) {}

	/** Gate 1: source group applied. */
	observeGate1(event: Gate1Event): void {
		if (this.gate1Version !== undefined) return;
		if (event.kind === "source-version") {
			if (event.ts >= this.requiredVersion) this.gate1Version = event.ts;
			return;
		}
		if (event.observedSeq >= event.ackSeq) this.gate1Version = event.ts;
	}

	/** Gate 2: derived result published. */
	observeGate2(event: Gate2Event): void {
		if (event.kind !== "checkpoint") return;
		if (this.discipline === "revision-tagged") {
			if (this.highestRevisionSeen !== undefined && event.version <= this.highestRevisionSeen) {
				return;
			}
			this.highestRevisionSeen = event.version;
			if (this.gate2Version === undefined && event.version === this.requiredVersion) {
				this.gate2Version = event.version;
			}
			return;
		}
		if (this.gate2Version === undefined && event.version >= this.requiredVersion) {
			this.gate2Version = event.version;
		}
	}

	get gate1(): boolean {
		return this.gate1Version !== undefined;
	}

	get gate2(): boolean {
		return this.gate2Version !== undefined;
	}

	/** The version gate 2 settled at, once reached. */
	get publishedVersion(): number | undefined {
		return this.gate2Version;
	}
}

/**
 * Quiesced-mode write coordinator: holds new harness writes until Q1
 * reports gates one and two (via `readiness`) and Q2 reports gate three
 * (via `reportGate3FromQ2`). This class is the only piece that combines
 * gates 1-3; `ReadinessDetector` itself never reads the oracle.
 */
export class QuiescedWriteCoordinator {
	private gate3Reached = false;

	constructor(private readonly readiness: ReadinessDetector) {}

	reportGate3FromQ2(): void {
		this.gate3Reached = true;
	}

	get writesHeld(): boolean {
		return !(this.readiness.gate1 && this.readiness.gate2 && this.gate3Reached);
	}
}
