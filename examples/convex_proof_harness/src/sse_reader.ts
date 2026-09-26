/**
 * The Skip-side reader (KTD7): a small, dependency-free SSE parser for
 * `POST /v1/streams/:resource` / `GET /v1/streams/:uuid`'s `init`/`update`
 * framing plus the reference service's `checkpoint` event (KTD4). One
 * reader serves both Q2's settled snapshot and Q14's every-event observer.
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U8,
 * Q2, Q14, KTD7.
 *
 * Framing versioned against `skip: skipruntime-ts/server/src/rest.ts`'s
 * `registerStreamingServiceRoutes`: `event: init`/`event: update` carry
 * `id: <watermark>` and `data: <Entry<K,V>[]>` (`Entry` is `[key,
 * values[]]`; an empty `values` array is a deletion); the 30s heartbeat is
 * `event: update` with `data:[]` and no `id:` line.
 */

import { HarnessError } from "./readiness.js";

export class SseParseError extends HarnessError {}

export type Entry = [unknown, unknown[]];

export type SseEvent =
	| { readonly kind: "init"; readonly watermark: string; readonly values: readonly Entry[] }
	| { readonly kind: "update"; readonly watermark: string; readonly values: readonly Entry[] }
	| { readonly kind: "heartbeat" }
	| { readonly kind: "checkpoint"; readonly version: number }
	| { readonly kind: "unknown-event"; readonly eventName: string };

export type SseRawFrame = { readonly event?: string; readonly id?: string; readonly data: string };

/**
 * Refuses a non-loopback URL. This is a minimum-exposure constraint on the
 * harness itself (Q2): the standalone SSE endpoints bind to loopback only
 * and serve only PoC/test-fixture data.
 */
export function assertLoopbackUrl(url: string): void {
	const parsed = new URL(url);
	const loopback =
		parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
	if (!loopback) {
		throw new HarnessError(`refused non-loopback stream URL: "${url}"`);
	}
}

/**
 * Incrementally splits raw SSE bytes into complete frames (blank-line
 * terminated), tolerating events split across chunks and multiple events
 * per chunk.
 */
export class SseFrameSplitter {
	private buffer = "";

	push(chunk: string): SseRawFrame[] {
		// Normalize CRLF/CR to LF so a CRLF-framed server still yields
		// blank-line boundaries instead of stalling the buffer forever.
		this.buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const frames: SseRawFrame[] = [];
		let boundary: number;
		while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
			frames.push(parseRawFrame(this.buffer.slice(0, boundary)));
			this.buffer = this.buffer.slice(boundary + 2);
		}
		return frames;
	}

	/**
	 * Throws on a non-whitespace trailing remainder (a truncated final
	 * frame) for finite streams. A blank/whitespace-only remainder is
	 * benign and is discarded.
	 */
	flush(): void {
		if (this.buffer.trim() !== "") {
			throw new SseParseError(`trailing incomplete SSE frame: ${JSON.stringify(this.buffer)}`);
		}
		this.buffer = "";
	}
}

function parseRawFrame(raw: string): SseRawFrame {
	let event: string | undefined;
	let id: string | undefined;
	const dataLines: string[] = [];
	for (const line of raw.split("\n")) {
		if (line.startsWith("event: ")) event = line.slice("event: ".length);
		else if (line.startsWith("id: ")) id = line.slice("id: ".length);
		// Per the SSE spec, repeated data: lines join with "\n" rather than
		// last-wins, so a multi-line JSON payload survives intact.
		else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
	}
	return { event, id, data: dataLines.join("\n") };
}

function parseEntries(frame: SseRawFrame, eventName: "init" | "update"): Entry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(frame.data);
	} catch {
		throw new SseParseError(`malformed data: for "${eventName}" event: ${frame.data}`);
	}
	if (!Array.isArray(parsed)) {
		throw new SseParseError(`unknown "${eventName}" variant: data: is not an array`);
	}
	for (const entry of parsed) {
		if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) {
			throw new SseParseError(`unknown "${eventName}" variant: malformed entry in data:`);
		}
	}
	return parsed as Entry[];
}

/** Classifies one raw frame. Throws on a known-name event with an unrecognized shape. */
export function classifyFrame(frame: SseRawFrame): SseEvent {
	if (frame.event === undefined || frame.event === "update") {
		if (frame.id === undefined) {
			// The heartbeat is specifically `event: update` with `data:[]`
			// and no `id:` line. An id-less frame carrying any other data
			// is not a heartbeat -- it is a malformed update (e.g. a server
			// bug dropped the id: line) and fails closed instead of being
			// silently swallowed.
			const trimmed = frame.data.trim();
			if (trimmed === "") return { kind: "heartbeat" };
			let parsed: unknown;
			try {
				parsed = JSON.parse(frame.data);
			} catch {
				throw new SseParseError(`unknown "update" variant: id-less frame has malformed data: ${frame.data}`);
			}
			if (Array.isArray(parsed) && parsed.length === 0) return { kind: "heartbeat" };
			throw new SseParseError(`unknown "update" variant: id-less frame has non-empty data: ${frame.data}`);
		}
		return { kind: "update", watermark: frame.id, values: parseEntries(frame, "update") };
	}
	if (frame.event === "init") {
		if (frame.id === undefined) {
			throw new SseParseError(`unknown "init" variant: missing id: line`);
		}
		return { kind: "init", watermark: frame.id, values: parseEntries(frame, "init") };
	}
	if (frame.event === "checkpoint") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(frame.data);
		} catch {
			throw new SseParseError(`malformed data: for "checkpoint" event: ${frame.data}`);
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as Record<string, unknown>)["version"] !== "number"
		) {
			throw new SseParseError(`malformed data: for "checkpoint" event: ${frame.data}`);
		}
		return { kind: "checkpoint", version: (parsed as { version: number }).version };
	}
	return { kind: "unknown-event", eventName: frame.event };
}

export type SseReaderCallbacks = {
	onInit?: (watermark: string, values: readonly Entry[]) => void;
	onUpdate?: (watermark: string, values: readonly Entry[]) => void;
	onHeartbeat?: () => void;
	onCheckpoint?: (version: number) => void;
	/** Counted, never a Skip mismatch; forces any spanning comparison sample to incomparable. */
	onUnknownEvent?: (eventName: string) => void;
};

/**
 * Wraps `SseFrameSplitter` + `classifyFrame` into a stateful reader
 * suitable for driving from real chunked HTTP bytes or a synthetic
 * transcript. Tracks `unknownEventCount` for callers that need to force a
 * spanning sample to incomparable.
 */
export class SseReader {
	private readonly splitter = new SseFrameSplitter();
	private unknownCount = 0;

	constructor(
		url: string,
		private readonly callbacks: SseReaderCallbacks,
	) {
		assertLoopbackUrl(url);
	}

	get unknownEventCount(): number {
		return this.unknownCount;
	}

	push(chunk: string): void {
		for (const raw of this.splitter.push(chunk)) {
			const event = classifyFrame(raw);
			switch (event.kind) {
				case "heartbeat":
					this.callbacks.onHeartbeat?.();
					break;
				case "init":
					this.callbacks.onInit?.(event.watermark, event.values);
					break;
				case "update":
					this.callbacks.onUpdate?.(event.watermark, event.values);
					break;
				case "checkpoint":
					this.callbacks.onCheckpoint?.(event.version);
					break;
				case "unknown-event":
					this.unknownCount += 1;
					this.callbacks.onUnknownEvent?.(event.eventName);
					break;
			}
		}
	}

	/**
	 * Throws `SseParseError` on a non-whitespace trailing remainder (a
	 * truncated final frame) for finite streams. Call after the last chunk.
	 */
	flush(): void {
		this.splitter.flush();
	}
}
