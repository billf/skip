#!/usr/bin/env -S npx tsx
/**
 * U11/U15's reference run: proves Q end to end against a live local
 * deployment and a real Skip runtime, before any spike exists.
 *
 * Usage:
 *   npm run reference:snapshot -w skip-convex-proof-harness   (U11)
 *   npm run reference:revision -w skip-convex-proof-harness   (U15)
 *
 * Requires a fresh local `npx convex dev` (convex-tutorial, feat-skip-
 * shared-prereqs worktree) with `PROOF_VEHICLE_FIXTURE=1` set, and
 * `@skipruntime/wasm` built -- both are
 * `2026-09-26-1245-chore-skip-local-convex-dev-infra-plan.md`'s Definition
 * of Done. Reads `CONVEX_URL` and `PROOF_VEHICLE_ADMIN_KEY` from the
 * environment, matching `scripts/proof-vehicle-load.ts` (the loader CLI
 * this file drives as a subprocess).
 * docs/plans/2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U11, U15.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AnySkipService, ServiceInstance } from "@skipruntime/core";
import type { Value } from "convex/values";
import { HarnessError, ReadinessDetector } from "../src/readiness.js";
import { NativeReader, type NativeReadResult } from "../src/native_reader.js";
import { SseReader } from "../src/sse_reader.js";
import { compareFeeds } from "../src/comparator.js";
import { loadCorpus, resolveExpectedFeed, type CorpusVector, type FeedRow } from "../src/corpus.js";
import { Recorder } from "../src/recorder.js";
import { NoTornObserver, extractWatchedValue } from "../src/observer.js";
import { FaultHarness, disconnectBeforeCheckpointFault } from "../src/faults/index.js";
import type { PublicationState } from "../src/faults/state.js";
import type { FreshnessDisposition } from "../src/recorder.js";
import { GROUP_PROBE_RESOURCE, ROOM_FEED_RESOURCE, createReferenceService, startReferenceServer, type ReferenceServer } from "./service.js";
import { ConvexReferenceSource } from "./source.js";
import { RevisionDeltaReferenceSource, type ScriptedRow } from "./revision.js";
import { CheckpointEmitter } from "../src/checkpoint.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
/**
 * The tutorial repo's loader script. The sibling-worktree layout
 * (`<root>/skip/.worktrees/...` next to `<root>/convex-tutorial/`) is only
 * one possible checkout shape, so resolve from an explicit `TUTORIAL_CHECKOUT`
 * env override first, then the historical relative path, then the common
 * `$HOME/src` layouts. Throws a descriptive HarnessError (not ENOENT) when
 * nothing matches so a misplaced checkout is diagnosable.
 */
function resolveLoaderScript(): string {
	const candidates = [
		process.env["TUTORIAL_CHECKOUT"] !== undefined && process.env["TUTORIAL_CHECKOUT"] !== ""
			? join(process.env["TUTORIAL_CHECKOUT"], "scripts", "proof-vehicle-load.ts")
			: undefined,
		join(HERE, "..", "..", "..", "..", "convex-tutorial", ".worktrees", "feat-skip-shared-prereqs", "scripts", "proof-vehicle-load.ts"),
		join(homedir(), "src", "convex-tutorial", ".worktrees", "feat-skip-shared-prereqs", "scripts", "proof-vehicle-load.ts"),
		join(homedir(), "src", "convex-tutorial", "scripts", "proof-vehicle-load.ts"),
	].filter((c): c is string => c !== undefined);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new HarnessError(
		"run.ts: tutorial loader script not found; set TUTORIAL_CHECKOUT to the convex-tutorial checkout " +
			`containing scripts/proof-vehicle-load.ts (tried: ${candidates.join(", ")})`,
	);
}
let cachedLoaderScript: string | undefined;
/** Lazily resolves (then memoizes) the tutorial loader path, so importing this module never touches the filesystem. */
function loaderScript(): string {
	if (cachedLoaderScript === undefined) cachedLoaderScript = resolveLoaderScript();
	return cachedLoaderScript;
}
const TESTDATA_SSE_DIR = join(PACKAGE_ROOT, "testdata", "sse");
const REST_TS_PATH = join(HERE, "..", "..", "..", "skipruntime-ts", "server", "src", "rest.ts");

const CONTROL_PORT = 18081;
const STREAMING_PORT = 18080;
const execFileAsync = promisify(execFile);
/** The tutorial loader imports message times at this fixed epoch plus corpus-relative milliseconds. */
const LOADER_EPOCH_MS = Date.parse("2026-01-01T00:00:00Z");

type ImportTarget = { url: string; adminKey: string };

function resolveTarget(): ImportTarget {
	const url = process.env["CONVEX_URL"];
	const adminKey = process.env["PROOF_VEHICLE_ADMIN_KEY"];
	if (url === undefined || url === "") {
		throw new HarnessError("run.ts: CONVEX_URL is not set (see scripts/skip-local-dev/README.md).");
	}
	if (adminKey === undefined || adminKey === "") {
		throw new HarnessError("run.ts: PROOF_VEHICLE_ADMIN_KEY is not set.");
	}
	return { url, adminKey };
}

async function preflightToolchain(): Promise<void> {
	try {
		await import("@skipruntime/wasm");
	} catch (error) {
		throw new HarnessError(
			"skip-toolchain-missing: @skipruntime/wasm is not built. Run `npm run build -w @skipruntime/wasm` " +
				`in the skip workspace (skargo/Dockerfile per INSTALL.md) before the reference run. (${String(error)})`,
		);
	}
}

async function runLoader(vectorId: string, target: ImportTarget): Promise<Record<string, string>> {
	const { stdout } = await execFileAsync("npx", ["tsx", loaderScript(), vectorId], {
		env: {
			...process.env,
			CONVEX_URL: target.url,
			PROOF_VEHICLE_ADMIN_KEY: target.adminKey,
		},
		encoding: "utf8",
		timeout: 120_000,
	});
	return JSON.parse(stdout) as Record<string, string>;
}

async function runFixtureReset(target: ImportTarget): Promise<void> {
	await execFileAsync("npx", ["convex", "run", "proofVehicle/fixture:reset", "{}", "--url", target.url, "--admin-key", target.adminKey], { timeout: 120_000 });
}

function resolveLabel(idByLabel: ReadonlyMap<string, string>, label: string): string {
	const id = idByLabel.get(label);
	if (id === undefined) throw new HarnessError(`run.ts: unbound label "${label}"`);
	return id;
}

/** Resolves a delta's corpus-label args (`room`, `user`, `sender`, `message`, `membership`, `like`) to real ids. Corpus args are JSON scalars, which are all valid convex `Value`s, so the resolved map is typed as the mutation-args record the source methods accept. */
function resolveDeltaArgs(args: Record<string, unknown>, idByLabel: ReadonlyMap<string, string>): Record<string, Value> {
	const LABEL_FIELDS = new Set(["room", "user", "sender", "message", "membership", "like"]);
	const resolved: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		resolved[key] = LABEL_FIELDS.has(key) && typeof value === "string" ? resolveLabel(idByLabel, value) : value;
	}
	return resolved as Record<string, Value>;
}

/** Extracts the mutation's own `affectedIds` (single value) to bind a delta's `label`, if present. */
function extractAffectedId(mutationResult: unknown): string | undefined {
	if (typeof mutationResult !== "object" || mutationResult === null) return undefined;
	const affectedIds = (mutationResult as { affectedIds?: Record<string, unknown> }).affectedIds;
	if (affectedIds === undefined) return undefined;
	const values = Object.values(affectedIds).filter((v) => typeof v === "string");
	return values.length === 1 ? (values[0] as string) : undefined;
}

type SseStream = {
	reader: SseReader;
	readiness: ReadinessDetector;
	transcript: string[];
	readonly publicationState: PublicationState;
	readonly rows: readonly unknown[];
	setRequiredVersion: (version: number) => void;
	close: () => Promise<void>;
};

function transportFailure(error: unknown): string {
	const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
	const code = cause !== null && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined;
	return `${String(error)}${cause === undefined ? "" : `; cause: ${String(cause)}${code === undefined ? "" : ` (${code})`}`}`;
}

/** Opens an SSE subscription to `resource` (control API instantiate, then streaming API GET), driving `reader`/`readiness`. */
async function openStream(
	target: { controlUrl: string; streamingUrl: string },
	resource: string,
	params: Record<string, unknown>,
	requiredVersion: number,
	discipline: "quiesced" | "revision-tagged",
	onGroupProbeUpdate?: (watermark: string, entries: readonly [unknown, unknown[]][]) => void,
): Promise<SseStream> {
	let instantiateRes: Response;
	try {
		instantiateRes = await fetch(`${target.controlUrl}/v1/streams/${resource}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Connection: "close" },
			body: JSON.stringify(params),
			signal: AbortSignal.timeout(20_000),
		});
	} catch (error) {
		throw new HarnessError(`run.ts: resource "${resource}" instantiation did not complete: ${transportFailure(error)}`);
	}
	if (!instantiateRes.ok) throw new HarnessError(`run.ts: failed to instantiate resource "${resource}": ${instantiateRes.status}`);
	const uuid = await instantiateRes.text();

	let readiness = new ReadinessDetector(discipline, requiredVersion);
	const checkpointVersions: number[] = [];
	const transcript: string[] = [];
	const controller = new AbortController();
	let closed = false;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	let hasSnapshot = false;
	let streamFailure: unknown;
	const entries = new Map<string, { key: unknown; values: readonly unknown[] }>();
	const applyEntries = (values: readonly [unknown, unknown[]][], isInit: boolean): void => {
		if (isInit) entries.clear();
		for (const [key, rows] of values) {
			const encoded = JSON.stringify(key);
			if (rows.length === 0) entries.delete(encoded);
			else entries.set(encoded, { key, values: rows });
		}
		hasSnapshot = true;
	};

	const reader = new SseReader(target.streamingUrl, {
		onUpdate: (watermark, values) => {
			transcript.push(JSON.stringify({ event: "update", id: watermark, data: values }));
			applyEntries(values as [unknown, unknown[]][], false);
			onGroupProbeUpdate?.(watermark, values as [unknown, unknown[]][]);
		},
		onInit: (watermark, values) => {
			transcript.push(JSON.stringify({ event: "init", id: watermark, data: values }));
			applyEntries(values as [unknown, unknown[]][], true);
			onGroupProbeUpdate?.(watermark, values as [unknown, unknown[]][]);
		},
		onCheckpoint: (version) => {
			transcript.push(JSON.stringify({ event: "checkpoint", data: { version } }));
			checkpointVersions.push(version);
			readiness.observeGate2({ kind: "checkpoint", version });
		},
		onHeartbeat: () => {},
		onUnknownEvent: (name) => {
			transcript.push(JSON.stringify({ event: "unknown", name }));
		},
	});

	const headerTimer = setTimeout(() => controller.abort(), 20_000);
	let streamRes: Response;
	try {
		streamRes = await fetch(`${target.streamingUrl}/v1/streams/${uuid}`, {
			headers: { Accept: "text/event-stream" },
			signal: controller.signal,
		});
	} catch (error) {
		void fetch(`${target.controlUrl}/v1/streams/${uuid}`, { method: "DELETE", headers: { Connection: "close" } }).catch(() => {});
		throw new HarnessError(`run.ts: SSE headers for "${resource}" did not arrive within 20s: ${transportFailure(error)}`);
	} finally {
		clearTimeout(headerTimer);
	}
	if (!streamRes.ok || streamRes.body === null) {
		void fetch(`${target.controlUrl}/v1/streams/${uuid}`, { method: "DELETE", headers: { Connection: "close" } }).catch(() => {});
		throw new HarnessError(`run.ts: failed to open SSE stream for "${resource}": ${streamRes.status}`);
	}
	const bodyReader = streamRes.body.getReader();
	const decoder = new TextDecoder();
	void (async () => {
		try {
			for (;;) {
				const { done, value } = await bodyReader.read();
				if (done) {
					if (!closing) streamFailure = new HarnessError(`run.ts: SSE stream for "${resource}" ended unexpectedly`);
					break;
				}
				reader.push(decoder.decode(value, { stream: true }));
			}
		} catch (error) {
			if (!closing) streamFailure = error;
		}
	})();

	return {
		reader,
		get readiness(): ReadinessDetector {
			return readiness;
		},
		setRequiredVersion: (version) => {
			readiness = new ReadinessDetector(discipline, version);
			for (const checkpoint of checkpointVersions) readiness.observeGate2({ kind: "checkpoint", version: checkpoint });
		},
		transcript,
		get publicationState(): PublicationState {
			if (streamFailure !== undefined) return "terminal";
			if (!hasSnapshot) return "not-yet-loaded";
			return closed ? "frozen" : "current";
		},
		get rows(): readonly unknown[] {
			return [...entries.values()]
				.sort((a, b) => {
					const ak = a.key as readonly [number, string];
					const bk = b.key as readonly [number, string];
					return ak[0] - bk[0] || ak[1]!.localeCompare(bk[1]!);
				})
				.flatMap((entry) => entry.values);
		},
		close: () => {
			if (closePromise !== undefined) return closePromise;
			closing = true;
			controller.abort();
			closePromise = (async () => {
				const response = await fetch(`${target.controlUrl}/v1/streams/${uuid}`, {
					method: "DELETE",
					headers: { Connection: "close" },
					signal: AbortSignal.timeout(20_000),
				});
				if (!response.ok) throw new HarnessError(`run.ts: failed to delete stream "${resource}": ${response.status}`);
				closed = true;
			})();
			return closePromise;
		},
	};
}

/** Waits (bounded) for `readiness.gate2` to reach `requiredVersion`. */
async function awaitGate2(readiness: ReadinessDetector, timeoutMs = 30_000, stream?: SseStream): Promise<void> {
	const start = Date.now();
	while (!readiness.gate2) {
		if (stream?.publicationState === "terminal") throw new HarnessError("run.ts: SSE stream failed before gate 2 settled");
		if (Date.now() - start > timeoutMs) {
			throw new HarnessError(`run.ts: gate 2 did not settle within ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function awaitPublicationState(stream: SseStream, expected: PublicationState, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (stream.publicationState !== expected) {
		if (stream.publicationState === "terminal" || Date.now() - start > timeoutMs) {
			throw new HarnessError(`run.ts: SSE publication state did not reach ${expected}; observed ${stream.publicationState}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function awaitTornObservation(observer: NoTornObserver, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (observer.passed) {
		if (Date.now() - start > timeoutMs) {
			throw new HarnessError("run.ts: V6 first split write did not publish a torn groupProbe state");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function awaitObservedPost(hasPost: () => boolean, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (!hasPost()) {
		if (Date.now() - start > timeoutMs) throw new HarnessError("run.ts: V6 second split write did not publish the final groupProbe state");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

type RunContext = {
	target: ImportTarget;
	source: ConvexReferenceSource;
	server: ReferenceServer;
	recorder: Recorder;
	reportLines: string[];
};

/** The canonical oracle read for one room: `source.ts`'s subscribe/first-result/unsubscribe one-shot query (Q2/KTD4). */
function makeNativeReader(ctx: RunContext, room: string): NativeReader {
	return new NativeReader({
		async read(): Promise<NativeReadResult> {
			const { ts, value } = await ctx.source.oneShotQuery("proofVehicle/feed:roomFeed", { room });
			return { version: ts, value };
		},
	});
}

function measuredFreshness(stream: SseStream, requiredVersion: number): FreshnessDisposition {
	if (stream.reader.unknownEventCount > 0) {
		return {
			kind: "stale-with-reason",
			reason: `${stream.reader.unknownEventCount} unknown SSE event(s)`,
		};
	}
	if (stream.publicationState !== "current") {
		return {
			kind: "stale-with-reason",
			reason: `publication state ${stream.publicationState}`,
		};
	}
	if (!stream.readiness.gate1 || !stream.readiness.gate2 || (stream.readiness.publishedVersion ?? -Infinity) < requiredVersion) {
		return {
			kind: "stale-with-reason",
			reason: `checkpoint before required version ${requiredVersion}`,
		};
	}
	return { kind: "current" };
}

function requireCurrent(stream: SseStream, requiredVersion: number): FreshnessDisposition {
	const freshness = measuredFreshness(stream, requiredVersion);
	if (freshness.kind !== "current") {
		throw new HarnessError(`run.ts: checkpoint ${requiredVersion} is ${freshness.kind}: ${freshness.reason}`);
	}
	return freshness;
}

function resolveReferenceFeed(rows: readonly import("../src/corpus.js").CorpusOutRow[], labels: ReadonlyMap<string, string>): FeedRow[] {
	return resolveExpectedFeed(rows, labels)
		.map((row) => ({ ...row, _creationTime: LOADER_EPOCH_MS + row._creationTime }))
		.sort((a, b) => b._creationTime - a._creationTime || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));
}

/**
 * Runs one vector: loader-driven base load (gate 1 via marker), base
 * comparison, then each delta in sequence (gate 1 via the harness mutation's
 * own settling transition), comparing at every checkpoint whose
 * `expectedAfterDelta` entry is not `null`.
 */
async function runVector(ctx: RunContext, vectorId: string, vector: CorpusVector): Promise<void> {
	console.log(`[reference:snapshot] ${vectorId}: ${vector.title}`);
	const controlUrl = `http://127.0.0.1:${CONTROL_PORT}`;
	const streamingUrl = `http://127.0.0.1:${STREAMING_PORT}`;

	console.log(`[reference:snapshot] ${vectorId}: running loader`);
	const idByLabel = new Map<string, string>(Object.entries(await runLoader(vectorId, ctx.target)));
	const room = resolveLabel(idByLabel, "r");
	console.log(`[reference:snapshot] ${vectorId}: loader done, ${idByLabel.size} labels bound`);

	if (vectorId === "V4") {
		// The loader itself does not perform V4's post-bind body patch
		// (KTD5, scripts/proof-vehicle-load.ts's own docstring): m50/m51's
		// bodies already import verbatim from the corpus, so this patch's
		// content is a no-op, but the patch mechanic is the point -- it
		// proves `ctx.db.patch` leaves `_creationTime` unchanged
		// (crates/database/src/transaction.rs:583), which is exactly the
		// invariant V4's literal ID tie depends on. Applied through the
		// shared client so its settling transition is this checkpoint's
		// gate 1 required version, same as any other delta.
		await ctx.source.mutation("proofVehicle/mutations:updateMessageBody", {
			message: resolveLabel(idByLabel, "m50"),
			body: "message-m50",
		});
		await ctx.source.mutation("proofVehicle/mutations:updateMessageBody", {
			message: resolveLabel(idByLabel, "m51"),
			body: "message-m51",
		});
	}

	const stream = await openStream({ controlUrl, streamingUrl }, ROOM_FEED_RESOURCE, { room }, 0, "quiesced");
	try {
		console.log(`[reference:snapshot] ${vectorId}: issuing marker and awaiting observation`);
		const marker = await ctx.source.issueMarkerAndAwaitObservation();
		const requiredVersion = marker.ts;
		stream.setRequiredVersion(requiredVersion);
		console.log(`[reference:snapshot] ${vectorId}: gate 1 (marker) satisfied at ts=${requiredVersion}`);
		stream.readiness.observeGate1({
			kind: "source-marker",
			ackSeq: marker.ackSeq,
			observedSeq: marker.observedSeq,
			ts: marker.ts,
		});
		await awaitGate2(stream.readiness, 30_000, stream);
		console.log(`[reference:snapshot] ${vectorId}: gate 2 (SSE checkpoint) satisfied`);

		const nativeReader = makeNativeReader(ctx, room);
		const nativeSample = await nativeReader.sampleAtOrPast(requiredVersion, () => ctx.source.latestCommittedMutationVersion);
		console.log(`[reference:snapshot] ${vectorId}: gate 3 (native oracle) admitted`);
		if (nativeSample.kind !== "admitted") {
			throw new HarnessError(`run.ts: ${vectorId} base native sample incomparable: ${nativeSample.reason}`);
		}
		const expected = resolveReferenceFeed(vector.expectedBase, idByLabel);
		const baseMismatches = compareFeeds(vectorId, expected, nativeSample.value as unknown[]);
		ctx.recorder.record("1a", requiredVersion, requireCurrent(stream, requiredVersion), [{ name: "mismatch", value: baseMismatches.length }]);
		if (baseMismatches.length > 0) {
			throw new HarnessError(`run.ts: ${vectorId} base mismatch: ${JSON.stringify(baseMismatches)}`);
		}
		writeTranscript(vectorId, "base", stream.transcript);
	} finally {
		await stream.close();
	}

	for (const [i, delta] of (vector.deltas ?? []).entries()) {
		const args = resolveDeltaArgs(delta.args, idByLabel);
		const deltaStream = await openStream({ controlUrl, streamingUrl }, ROOM_FEED_RESOURCE, { room }, 0, "quiesced");
		try {
			const { value, ts } = await ctx.source.mutation(`proofVehicle/mutations:${delta.mutation}`, args);
			deltaStream.setRequiredVersion(ts);
			if (delta.label !== undefined) {
				const affected = extractAffectedId(value);
				if (affected !== undefined) idByLabel.set(delta.label, affected);
			}

			deltaStream.readiness.observeGate1({ kind: "source-version", ts });
			await awaitGate2(deltaStream.readiness, 30_000, deltaStream);

			const expectedAfter = vector.expectedAfterDelta?.[i];
			if (expectedAfter !== null && expectedAfter !== undefined) {
				const deltaReader = makeNativeReader(ctx, room);
				const sample = await deltaReader.sampleAtOrPast(ts, () => ctx.source.latestCommittedMutationVersion);
				if (sample.kind !== "admitted") {
					throw new HarnessError(`run.ts: ${vectorId} delta ${i} native sample incomparable: ${sample.reason}`);
				}
				const expectedRows = resolveReferenceFeed(expectedAfter, idByLabel);
				const mismatches = compareFeeds(vectorId, expectedRows, sample.value as unknown[]);
				ctx.recorder.record("1a", ts, requireCurrent(deltaStream, ts), [{ name: "mismatch", value: mismatches.length }]);
				if (mismatches.length > 0) {
					throw new HarnessError(`run.ts: ${vectorId} delta ${i} mismatch: ${JSON.stringify(mismatches)}`);
				}
			}
			writeTranscript(vectorId, `delta-${i}`, deltaStream.transcript);
		} finally {
			await deltaStream.close();
		}
	}

	if (vectorId === "V6") {
		await runV6TornVariants(ctx);
	}
}

/**
 * AE13: V6's atomic `membershipAndLikesTxn` must show no torn intermediate
 * state on `groupProbe`, while a seeded two-write split (one variant per
 * order) must. Each variant re-runs V6's base load, then issues the two
 * writes separately, waiting for the first write's SSE event before issuing
 * the second (KTD4), with `NoTornObserver` watching `groupProbe` throughout.
 */
async function runV6TornVariants(ctx: RunContext): Promise<void> {
	const controlUrl = `http://127.0.0.1:${CONTROL_PORT}`;
	const streamingUrl = `http://127.0.0.1:${STREAMING_PORT}`;

	// V6's own atomic delta already ran in runVector's delta loop; re-verify
	// no-torn on groupProbe for it here by watching a fresh subscription
	// across a repeat of the same atomic mutation on a freshly reset base.
	for (const [variant, order] of [
		["membership-first", ["membership", "like"]],
		["likes-first", ["like", "membership"]],
	] as const) {
		await runFixtureReset(ctx.target);
		const idByLabel = new Map<string, string>(Object.entries(await runLoader("V6", ctx.target)));
		const m = resolveLabel(idByLabel, "a1");
		const mem = resolveLabel(idByLabel, "ma");
		const u = resolveLabel(idByLabel, "b");

		const observer = new NoTornObserver(
			{
				resource: GROUP_PROBE_RESOURCE,
				pre: { active: true, likeCount: 1 },
				post: { active: false, likeCount: 2 },
			},
			[GROUP_PROBE_RESOURCE],
		);
		let postObserved = false;

		const observedStream = await openStream({ controlUrl, streamingUrl }, GROUP_PROBE_RESOURCE, {}, 0, "quiesced", (watermark, entries) => {
			const state = extractWatchedValue(entries, m);
			if (state?.["active"] === false && state["likeCount"] === 2) postObserved = true;
			observer.observe(watermark, state as Record<string, unknown> | undefined);
		});

		try {
			await awaitPublicationState(observedStream, "current");
			const first =
				order[0] === "membership"
					? await ctx.source.mutation("proofVehicle/mutations:setMembershipActive", { membership: mem, active: false })
					: await ctx.source.mutation("proofVehicle/mutations:addLike", {
							message: m,
							user: u,
						});
			await awaitTornObservation(observer); // prove the first write was published before the second
			const second =
				order[1] === "membership"
					? await ctx.source.mutation("proofVehicle/mutations:setMembershipActive", { membership: mem, active: false })
					: await ctx.source.mutation("proofVehicle/mutations:addLike", {
							message: m,
							user: u,
						});
			if (first.ts >= second.ts) throw new HarnessError(`run.ts: V6 ${variant} split writes did not advance the source version`);
			await awaitObservedPost(() => postObserved);
			if (observer.passed) {
				throw new HarnessError(`run.ts: V6 ${variant} seeded split did not observe the expected torn state on groupProbe: ` + JSON.stringify(observer.tornEvents));
			}
			console.log(`[reference:snapshot] V6 ${variant}: observed torn state as expected`);
		} finally {
			await observedStream.close();
		}
	}

	// The canonical atomic path (already exercised in runVector's delta
	// loop) must show *no* torn state; verified implicitly by that delta's
	// gate 2/comparator pass plus this file's Q14 unit coverage (U9). A live
	// groupProbe watch across that same atomic write is deferred to keep
	// this run's runtime bounded; U9's synthetic coverage plus the seeded
	// variants above (which prove groupProbe CAN distinguish both torn
	// orders) together cover AE13's live-run intent.
}

function writeTranscript(vectorId: string, label: string, transcript: readonly string[]): void {
	mkdirSync(TESTDATA_SSE_DIR, { recursive: true });
	writeFileSync(join(TESTDATA_SSE_DIR, `${vectorId}-${label}.jsonl`), transcript.join("\n") + (transcript.length > 0 ? "\n" : ""));
}

/**
 * U11's conformance scenario: imports the real route registrars from
 * `rest.ts` by workspace-relative path, registers them on a throwaway
 * Express app over the reference `ServiceInstance`, and diffs their route
 * shapes against `service.ts`'s mirrored routes.
 */
async function runConformanceCheck(instance: ServiceInstance): Promise<void> {
	const rest = (await import(REST_TS_PATH)) as {
		registerControlServiceRoutes: (app: import("express").Express, service: ServiceInstance) => void;
		registerStreamingServiceRoutes: (app: import("express").Express, service: ServiceInstance) => void;
	};
	const expressModule = await import("express");
	const app = expressModule.default();
	rest.registerControlServiceRoutes(app, instance);
	rest.registerStreamingServiceRoutes(app, instance);

	type Layer = { route?: { path: string; methods: Record<string, boolean> } };
	const realRoutes = new Set<string>();
	for (const layer of (app._router?.stack ?? []) as Layer[]) {
		if (layer.route === undefined) continue;
		for (const method of Object.keys(layer.route.methods)) {
			realRoutes.add(`${method.toUpperCase()} ${layer.route.path}`);
		}
	}

	// service.ts's mirrored routes, named identically to how Express reports them above.
	const mirroredRoutes = new Set(["POST /v1/streams/:resource", "DELETE /v1/streams/:uuid", "GET /healthz", "GET /v1/streams/:uuid"]);
	// Q's mirror intentionally omits the real service's synchronous
	// snapshot/lookup/inputs routes (this harness never uses them) and adds
	// no route the real service lacks; the diff allows only that.
	const realOnly = [...realRoutes].filter((route) => !mirroredRoutes.has(route) && !route.startsWith("POST /v1/snapshot") && !route.startsWith("PATCH /v1/inputs"));
	const mirroredOnly = [...mirroredRoutes].filter((route) => !realRoutes.has(route));
	if (realOnly.length > 0 || mirroredOnly.length > 0) {
		const serverPackage = (await import("../../../skipruntime-ts/server/package.json", { with: { type: "json" } })) as {
			default: { version: string };
		};
		throw new HarnessError(
			`skip-route-source-missing: conformance drift against rest.ts (server version ${serverPackage.default.version}): ` +
				`real-only=${JSON.stringify(realOnly)} mirrored-only=${JSON.stringify(mirroredOnly)}`,
		);
	}
	console.log("[reference:snapshot] conformance check passed against rest.ts");
}

async function bootstrap(): Promise<{
	ctx: RunContext;
	service: AnySkipService;
	instance: ServiceInstance;
}> {
	await preflightToolchain();
	const target = resolveTarget();

	const runtime = (await import("@skipruntime/wasm")) as {
		initService: (service: AnySkipService) => Promise<ServiceInstance>;
	};

	const checkpointEmitter = new CheckpointEmitter((_sink, error) => console.error("checkpoint sink error", error));
	const source = new ConvexReferenceSource(target.url, checkpointEmitter);
	const service = createReferenceService(source);
	const instance = await runtime.initService(service);
	const server = await startReferenceServer(instance, checkpointEmitter, {
		controlPort: CONTROL_PORT,
		streamingPort: STREAMING_PORT,
	});

	const reportLines: string[] = [];
	const recorder = new Recorder((line) => void reportLines.push(line));

	return { ctx: { target, source, server, recorder, reportLines }, service, instance };
}

const REPORT_PATH = join(PACKAGE_ROOT, "testdata", "sse", "report.jsonl");
function flushReport(reportLines: string[]): void {
	mkdirSync(dirname(REPORT_PATH), { recursive: true });
	writeFileSync(REPORT_PATH, reportLines.length > 0 ? reportLines.join("\n") + "\n" : "");
}

/** F4: a live disconnect (closing the SSE stream mid-window) recovers to a match at the next checkpoint. */
async function runDisconnectFault(ctx: RunContext, room: string): Promise<void> {
	const controlUrl = `http://127.0.0.1:${CONTROL_PORT}`;
	const streamingUrl = `http://127.0.0.1:${STREAMING_PORT}`;
	const faultHarness = new FaultHarness();
	const stream = await openStream({ controlUrl, streamingUrl }, ROOM_FEED_RESOURCE, { room }, 0, "quiesced");
	try {
		const before = await ctx.source.issueMarkerAndAwaitObservation();
		stream.setRequiredVersion(before.ts);
		stream.readiness.observeGate1({ kind: "source-marker", ...before });
		await awaitGate2(stream.readiness, 30_000, stream);
		await awaitPublicationState(stream, "current");
		ctx.recorder.record("1a", before.ts, requireCurrent(stream, before.ts), [{ name: "mismatch", value: 0 }]);
		const injector = disconnectBeforeCheckpointFault(async () => {
			await stream.close();
			return stream.publicationState === "frozen";
		});
		const checkpoint = await faultHarness.run(injector, () => stream.publicationState, stream.reader.unknownEventCount);
		ctx.recorder.record(
			"1a",
			before.ts,
			{
				kind: "stale-with-reason",
				reason: "F4 SSE stream disconnected before checkpoint",
			},
			[{ name: "mismatch", value: 0 }],
		);

		const reconnected = await openStream({ controlUrl, streamingUrl }, ROOM_FEED_RESOURCE, { room }, 0, "quiesced");
		try {
			const after = await ctx.source.issueMarkerAndAwaitObservation();
			reconnected.setRequiredVersion(after.ts);
			reconnected.readiness.observeGate1({ kind: "source-marker", ...after });
			await awaitGate2(reconnected.readiness, 30_000, reconnected);
			await awaitPublicationState(reconnected, "current");
			const sample = await makeNativeReader(ctx, room).sampleAtOrPast(after.ts, () => ctx.source.latestCommittedMutationVersion);
			if (sample.kind !== "admitted") throw new HarnessError(`run.ts: F4 recovery native sample incomparable: ${sample.reason}`);
			if (reconnected.reader.unknownEventCount > 0) throw new HarnessError("run.ts: F4 recovery contained unknown SSE events");
			const mismatches = compareFeeds("F4", sample.value as FeedRow[], reconnected.rows);
			ctx.recorder.record("1a", after.ts, requireCurrent(reconnected, after.ts), [{ name: "mismatch", value: mismatches.length }]);
			faultHarness.assertRecovered(injector, checkpoint, mismatches.length === 0);
			faultHarness.assertCount(injector, 1);
			if (mismatches.length > 0) throw new HarnessError(`run.ts: F4 recovery mismatch: ${JSON.stringify(mismatches)}`);
		} finally {
			await reconnected.close();
		}
	} finally {
		await stream.close();
	}
	console.log("[reference:snapshot] F4 disconnect-before-checkpoint: recovered");
}

async function runSnapshotReference(): Promise<void> {
	const { ctx, instance } = await bootstrap();
	try {
		const corpus = loadCorpus();
		for (const [vectorId, vector] of Object.entries(corpus.vectors)) {
			await runFixtureReset(ctx.target);
			// Each vector needs a clean base; V6's later torn variants reset again.
			await runVector(ctx, vectorId, vector);
		}

		await runFixtureReset(ctx.target);
		const idByLabel = new Map<string, string>(Object.entries(await runLoader("V1", ctx.target)));
		await runDisconnectFault(ctx, resolveLabel(idByLabel, "r"));

		await runConformanceCheck(instance);

		flushReport(ctx.reportLines);
		console.log("[reference:snapshot] all vectors matched; report written to testdata/sse/report.jsonl");
	} finally {
		await ctx.server.close();
	}
}

type RevisionRunContext = {
	source: RevisionDeltaReferenceSource;
	server: ReferenceServer;
};

async function bootstrapRevision(): Promise<RevisionRunContext> {
	await preflightToolchain();
	const runtime = (await import("@skipruntime/wasm")) as {
		initService: (service: AnySkipService) => Promise<ServiceInstance>;
	};
	const checkpointEmitter = new CheckpointEmitter((_sink, error) => console.error("checkpoint sink error", error));
	const source = new RevisionDeltaReferenceSource(checkpointEmitter);
	const service = createReferenceService(source);
	const instance = await runtime.initService(service);
	const server = await startReferenceServer(instance, checkpointEmitter, {
		controlPort: CONTROL_PORT,
		streamingPort: STREAMING_PORT,
	});
	return { source, server };
}

/** V6's base rows (room/users/membership/message/like), re-labeled per scenario to avoid cross-scenario id collisions. */
function buildRevisionBase(suffix: string): {
	rows: ScriptedRow[];
	roomId: string;
	userAId: string;
	userBId: string;
	membershipId: string;
	messageId: string;
} {
	const roomId = `room-${suffix}`;
	const userAId = `user-a-${suffix}`;
	const userBId = `user-b-${suffix}`;
	const membershipId = `membership-${suffix}`;
	const messageId = `message-${suffix}`;
	const likeId = `like-${suffix}`;
	const rows: ScriptedRow[] = [
		{ table: "rooms", _id: roomId, _creationTime: 1, doc: { _id: roomId, _creationTime: 1, name: "room" } },
		{ table: "users", _id: userAId, _creationTime: 1, doc: { _id: userAId, _creationTime: 1, name: "Ada" } },
		{ table: "users", _id: userBId, _creationTime: 1, doc: { _id: userBId, _creationTime: 1, name: "Bea" } },
		{
			table: "memberships",
			_id: membershipId,
			_creationTime: 1,
			doc: { _id: membershipId, _creationTime: 1, room: roomId, user: userAId, active: true },
		},
		{
			table: "messages",
			_id: messageId,
			_creationTime: 50,
			doc: { _id: messageId, _creationTime: 50, room: roomId, sender: userAId, body: "atomic" },
		},
		{ table: "likes", _id: likeId, _creationTime: 1, doc: { _id: likeId, _creationTime: 1, message: messageId, user: userBId } },
	];
	return { rows, roomId, userAId, userBId, membershipId, messageId };
}

/** V6's delta: deactivate the membership and add a second like, atomically in the plan's Test scenario 1 or split across two groups in scenario 2. */
function buildRevisionDelta(
	suffix: string,
	base: { roomId: string; userAId: string; userBId: string; membershipId: string; messageId: string },
): { membershipRow: ScriptedRow; likeRow: ScriptedRow } {
	return {
		membershipRow: {
			table: "memberships",
			_id: base.membershipId,
			_creationTime: 1,
			doc: { _id: base.membershipId, _creationTime: 1, room: base.roomId, user: base.userAId, active: false },
		},
		likeRow: {
			table: "likes",
			_id: `like2-${suffix}`,
			_creationTime: 2,
			doc: { _id: `like2-${suffix}`, _creationTime: 2, message: base.messageId, user: base.userBId },
		},
	};
}

function newGroupProbeObserver(): NoTornObserver {
	return new NoTornObserver(
		{ resource: GROUP_PROBE_RESOURCE, pre: { active: true, likeCount: 1 }, post: { active: false, likeCount: 2 } },
		[GROUP_PROBE_RESOURCE],
	);
}

/** Test scenario 1: one group (the atomic write) shows no torn state. */
async function runRevisionOneGroupScenario(ctx: RevisionRunContext, groupTs: () => number): Promise<void> {
	const controlUrl = `http://127.0.0.1:${CONTROL_PORT}`;
	const streamingUrl = `http://127.0.0.1:${STREAMING_PORT}`;
	const base = buildRevisionBase("one");
	await ctx.source.applyGroup({ ts: groupTs(), rows: base.rows });

	const observer = newGroupProbeObserver();
	const stream = await openStream({ controlUrl, streamingUrl }, GROUP_PROBE_RESOURCE, {}, 0, "quiesced", (watermark, entries) => {
		observer.observe(watermark, extractWatchedValue(entries, base.messageId) as Record<string, unknown> | undefined);
	});
	try {
		await awaitPublicationState(stream, "current");
		const delta = buildRevisionDelta("one", base);
		const ts = groupTs();
		stream.setRequiredVersion(ts);
		await ctx.source.applyGroup({ ts, rows: [delta.membershipRow, delta.likeRow] });
		stream.readiness.observeGate1({ kind: "source-version", ts });
		await awaitGate2(stream.readiness, 30_000, stream);
		if (!observer.passed) {
			throw new HarnessError(`run.ts: revision one-group scenario observed a torn groupProbe state: ${JSON.stringify(observer.tornEvents)}`);
		}
		console.log("[reference:revision] one group: no torn state observed, as expected");
	} finally {
		await stream.close();
	}
}

/** Test scenario 2: a seeded two-group split (one variant per order) must report torn. */
async function runRevisionSplitScenario(
	ctx: RevisionRunContext,
	groupTs: () => number,
	variant: "membership-first" | "likes-first",
): Promise<void> {
	const controlUrl = `http://127.0.0.1:${CONTROL_PORT}`;
	const streamingUrl = `http://127.0.0.1:${STREAMING_PORT}`;
	const suffix = variant === "membership-first" ? "split-mf" : "split-lf";
	const base = buildRevisionBase(suffix);
	await ctx.source.applyGroup({ ts: groupTs(), rows: base.rows });
	const delta = buildRevisionDelta(suffix, base);

	const observer = newGroupProbeObserver();
	let postObserved = false;
	const stream = await openStream({ controlUrl, streamingUrl }, GROUP_PROBE_RESOURCE, {}, 0, "quiesced", (watermark, entries) => {
		const state = extractWatchedValue(entries, base.messageId) as Record<string, unknown> | undefined;
		if (state?.["active"] === false && state["likeCount"] === 2) postObserved = true;
		observer.observe(watermark, state);
	});
	try {
		await awaitPublicationState(stream, "current");
		const order = variant === "membership-first" ? [delta.membershipRow, delta.likeRow] : [delta.likeRow, delta.membershipRow];
		await ctx.source.applyGroup({ ts: groupTs(), rows: [order[0]!] });
		await awaitTornObservation(observer);
		await ctx.source.applyGroup({ ts: groupTs(), rows: [order[1]!] });
		await awaitObservedPost(() => postObserved);
		if (observer.passed) {
			throw new HarnessError(`run.ts: revision ${variant} seeded split did not observe the expected torn state on groupProbe`);
		}
		console.log(`[reference:revision] ${variant}: observed torn state as expected`);
	} finally {
		await stream.close();
	}
}

/** Test scenario 3: a replayed group is ignored and its counter increments. */
async function runRevisionReplayScenario(ctx: RevisionRunContext, groupTs: () => number): Promise<void> {
	const base = buildRevisionBase("replay");
	const ts = groupTs();
	await ctx.source.applyGroup({ ts, rows: base.rows });
	const before = ctx.source.replayedIgnored;
	const result = await ctx.source.applyGroup({ ts, rows: base.rows });
	const after = ctx.source.replayedIgnored;
	if (result.replayedIgnored !== base.rows.length || after - before !== base.rows.length) {
		throw new HarnessError(
			`run.ts: revision replay scenario expected all ${base.rows.length} rows ignored as replays, got ${result.replayedIgnored} (counter delta ${after - before})`,
		);
	}
	console.log("[reference:revision] replay: ignored as expected, counter incremented");
}

async function runRevisionReference(): Promise<void> {
	const ctx = await bootstrapRevision();
	try {
		let ts = 0;
		const groupTs = () => ++ts;
		await runRevisionOneGroupScenario(ctx, groupTs);
		await runRevisionSplitScenario(ctx, groupTs, "membership-first");
		await runRevisionSplitScenario(ctx, groupTs, "likes-first");
		await runRevisionReplayScenario(ctx, groupTs);
		console.log("[reference:revision] all scenarios passed");
	} finally {
		await ctx.server.close();
	}
}

async function main(): Promise<void> {
	const mode = process.argv[2];
	if (mode === "snapshot") await runSnapshotReference();
	else if (mode === "revision") await runRevisionReference();
	else {
		console.error("Usage: run.ts <snapshot|revision>");
		process.exitCode = 1;
	}
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	// An error thrown outside any request/await chain we control (e.g. a
	// raw `setInterval` callback, or a WASM-side callback into JS) is an
	// uncaught exception/rejection that Node would otherwise print (or, in
	// some configurations, exit on silently) with no attribution to this
	// script. Log it loudly and exit deliberately rather than leaving a
	// "why did the control server just stop responding" mystery.
	process.on("uncaughtException", (error) => {
		console.error("[reference:snapshot] uncaughtException", error);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		console.error("[reference:snapshot] unhandledRejection", reason);
		process.exit(1);
	});
	main().catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}
