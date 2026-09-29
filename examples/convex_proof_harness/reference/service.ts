/**
 * U11's reference Skip service (KTD4): mounts U3's room feed and
 * `groupProbe` on a real `@skipruntime/wasm` runtime instance, behind
 * Q-owned Express routes that mirror `skip: skipruntime-ts/server/src/rest.ts`
 * (POST/GET/DELETE `/v1/streams`, plus the `checkpoint` event), bound
 * explicitly to `127.0.0.1` only.
 *
 * Deliberately does not use `@skipruntime/server`'s `runService`: that
 * calls `listen(port)` with no host
 * (`skip: skipruntime-ts/server/src/server.ts:147,160`), which binds every
 * interface, not loopback-only (see the plan's Assumptions, P8). This file
 * hand-rolls the same route shapes instead. The *real* route registrars
 * from `rest.ts` are imported only by `run.ts`'s conformance scenario,
 * which diffs them against these mirrored routes.
 * docs/plans/2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U11.
 */

import type { Server } from "node:http";
import express from "express";
import type { Express } from "express";
import type {
	AnySkipService,
	Context,
	EagerCollection,
	ExternalService,
	Json,
	Mapper,
	Resource,
	ServiceInstance,
	Values,
} from "@skipruntime/core";
import { SkipResourceInstanceInUseError, SkipUnknownCollectionError, deepFreeze } from "@skipruntime/core";
import {
	SplitByTable,
	deriveRoomFeedInputs,
	buildGroupProbe,
	buildRoomFeed,
	type LikeDoc,
	type MembershipDoc,
	type MessageDoc,
	type RoomFeedInputs,
	type TaggedRow,
	type UserDoc,
} from "@skip-adapter/atomic-batch";
import { CheckpointEmitter, formatCheckpointFrame } from "../src/checkpoint.js";

/**
 * The five contract tables the split mapper accepts, besides the
 * harness-only marker table. `SplitByTable`'s constructor params must be
 * `DepSafe` (Mapper/Reducer constructor param convention -- see split.ts),
 * so this is deep-frozen before use rather than typed as a plain `Set`.
 */
const KNOWN_TABLES = deepFreeze(new Set(["rooms", "users", "memberships", "messages", "likes"]));

/**
 * The component tag this service's split rows carry (distinct from
 * `CONTROL_COMPONENT`, which `SplitByTable` reserves for marker rows
 * regardless of the component passed here -- see split.ts).
 */
export const SOURCE_COMPONENT = "proofVehicle";

export const CONVEX_SOURCE_NAME = "convexSource";
export const ALL_SELECTED_ROWS_RESOURCE = "allSelectedRows";
export const ROOM_FEED_RESOURCE = "roomFeed";
export const GROUP_PROBE_RESOURCE = "groupProbe";

/**
 * Filters a `SplitByTable`-produced collection (keyed
 * `<component>/<table>/<id>`) down to one table's rows, re-keyed by the
 * row's own `_id` -- the per-table collection shape `deriveRoomFeedInputs`
 * expects (mirrors room_feed.ts's own `ById`, table-scoped).
 */
class TableRowsById<V extends Json & { readonly _id: string }> implements Mapper<string, Json, string, V> {
	constructor(private readonly table: string) {}

	mapEntry(key: string, values: Values<Json>): Iterable<[string, V]> {
		// namespacedKey format is "<component>/<table>/<id>"; ids never
		// contain "/" (keys.ts's own invariant), so a 3-way split is safe.
		const parts = key.split("/");
		if (parts.length !== 3 || parts[1] !== this.table) return [];
		return [[key.slice(key.indexOf("/", key.indexOf("/") + 1) + 1), values.getUnique() as V]];
	}
}

type Graph = RoomFeedInputs;

class RoomFeedResourceWrapper implements Resource<Graph> {
	private readonly room: string;
	constructor(params: Json) {
		if (
			params === null ||
			typeof params !== "object" ||
			Array.isArray(params) ||
			typeof (params as Record<string, unknown>)["room"] !== "string"
		) {
			throw new TypeError(`${ROOM_FEED_RESOURCE}: expected { room: string } params`);
		}
		this.room = (params as { room: string }).room;
	}
	instantiate(collections: Graph): EagerCollection<readonly [number, string], Json> {
		return buildRoomFeed(this.room, collections);
	}
}

class GroupProbeResourceWrapper implements Resource<Graph> {
	constructor(params: Json) {
		if (
			params === null ||
			typeof params !== "object" ||
			Array.isArray(params) ||
			Object.keys(params as Record<string, unknown>).length !== 0
		) {
			throw new TypeError(`${GROUP_PROBE_RESOURCE}: accepts no subscription parameters`);
		}
	}
	instantiate(collections: Graph): EagerCollection<string, Json> {
		return buildGroupProbe(collections);
	}
}

/**
 * The reference service definition: one external resource
 * (`convexSource`/`allSelectedRows`, supplied by `source.ts`'s
 * `ExternalService`) split by table and wired into U3's room-feed graph.
 */
export function createReferenceService(convexSource: ExternalService): AnySkipService {
	return {
		inputs: {},
		resources: {
			[ROOM_FEED_RESOURCE]: RoomFeedResourceWrapper,
			[GROUP_PROBE_RESOURCE]: GroupProbeResourceWrapper,
		},
		externalServices: { [CONVEX_SOURCE_NAME]: convexSource },
		createGraph(_inputs: Record<string, never>, context: Context): Graph {
			const allSelectedRows = context.useExternalResource<string, TaggedRow>({
				service: CONVEX_SOURCE_NAME,
				identifier: ALL_SELECTED_ROWS_RESOURCE,
				params: {},
			});
			const split = allSelectedRows.map(SplitByTable, SOURCE_COMPONENT, deepFreeze(KNOWN_TABLES));
			return deriveRoomFeedInputs({
				messagesById: split.map(TableRowsById<MessageDoc>, "messages"),
				usersById: split.map(TableRowsById<UserDoc>, "users"),
				membershipsById: split.map(TableRowsById<MembershipDoc>, "memberships"),
				likesById: split.map(TableRowsById<LikeDoc>, "likes"),
			});
		},
	};
}

export type ReferenceServer = {
	readonly checkpointEmitter: CheckpointEmitter;
	readonly instance: ServiceInstance;
	close(): Promise<void>;
};

/**
 * `Express.listen()`'s callback only fires on success ('listening'); a bind
 * failure (e.g. `EADDRINUSE` from a leftover process still holding the
 * port) instead emits an unhandled 'error' event on the returned server,
 * which crashes the process opaquely with no attribution to which server
 * failed. Attaching an 'error' listener before `listen()` turns that into a
 * clear rejection instead.
 */
function listenOrThrow(app: Express, port: number, label: string): Promise<Server> {
	return new Promise<Server>((resolve, reject) => {
		const server = app.listen(port, "127.0.0.1");
		server.once("listening", () => resolve(server));
		server.once("error", (error: unknown) => {
			reject(new Error(`${label}: failed to bind 127.0.0.1:${port} (${String(error)})`));
		});
	});
}

function assertLoopbackListen(server: Server, label: string): void {
	const address = server.address();
	if (address === null || typeof address === "string" || !["127.0.0.1", "::1"].includes(address.address)) {
		throw new Error(`${label}: refused to confirm loopback-only bind, got ${JSON.stringify(address)}`);
	}
}

/**
 * Starts the reference service's control and streaming HTTP servers, both
 * bound explicitly to `127.0.0.1` (never the bare `listen(port)` form,
 * which binds every interface). Q-owned routes mirror
 * `registerControlServiceRoutes`/`registerStreamingServiceRoutes`
 * (`skip: skipruntime-ts/server/src/rest.ts`) plus the `checkpoint` event
 * (KTD4); `run.ts`'s conformance scenario is what checks that mirror against
 * the real registrars.
 *
 * `checkpointEmitter` is caller-owned and shared with `source.ts`'s
 * `ConvexReferenceSource`, which calls `.checkpoint(ts)` after each
 * transition's `writer.update` resolves; this function only fans it out to
 * open SSE streams.
 */
export async function startReferenceServer(
	instance: ServiceInstance,
	checkpointEmitter: CheckpointEmitter,
	options: { controlPort: number; streamingPort: number },
): Promise<ReferenceServer> {
	const controlApp: Express = express();
	controlApp.use(express.json({ strict: false }));
	controlApp.post("/v1/streams/:resource", (req, res) => {
		const uuid = crypto.randomUUID();
		instance
			.instantiateResource(uuid, req.params.resource, req.body as Json)
			.then(() => res.status(201).send(uuid))
			.catch((e: unknown) => {
				console.error(e);
				res.status(500).json({ error: "Internal server error" });
			});
	});
	controlApp.delete("/v1/streams/:uuid", (req, res) => {
		try {
			instance.closeResourceInstance(req.params.uuid);
			res.sendStatus(200);
		} catch (e: unknown) {
			console.error(e);
			res.status(500).json({ error: "Internal server error" });
		}
	});
	controlApp.get("/healthz", (_req, res) => {
		res.sendStatus(200);
	});

	const streamingApp: Express = express();
	streamingApp.get("/v1/streams/:uuid", (req, res) => {
		if (!req.accepts("text/event-stream")) {
			res.sendStatus(406);
			return;
		}
		try {
			const uuid = req.params.uuid;
			// `res.write` after the response has ended (client closed first,
			// or a DELETE races this connection's own `req.on("close")`
			// cleanup) throws synchronously. The heartbeat interval and the
			// checkpoint sink both fire from outside Express's request
			// pipeline (a raw `setInterval` and the shared
			// `CheckpointEmitter`'s fan-out), so an uncaught throw there is
			// an uncaught exception that kills the whole process, not just
			// this request -- guard every write against `writableEnded`.
			const safeWrite = (frame: string): void => {
				if (res.writableEnded) return;
				try {
					res.write(frame);
				} catch (error: unknown) {
					console.error("streaming write after end", error);
				}
			};
			const sink = safeWrite;
			const subscriptionID = instance.subscribe(uuid, {
				subscribed: () => {
					res.set("Content-Type", "text/event-stream");
					res.set("Connection", "keep-alive");
					res.set("Cache-Control", "no-cache");
					res.status(200);
					res.flushHeaders();
					checkpointEmitter.addSink(sink);
				},
				notify: (update) => {
					safeWrite(`event: ${update.isInitial ? "init" : "update"}\n`);
					safeWrite(`id: ${update.watermark}\n`);
					safeWrite(`data: ${JSON.stringify(update.values)}\n\n`);
				},
				close: () => {
					checkpointEmitter.removeSink(sink);
					if (!res.writableEnded) res.end();
				},
			});
			const heartbeat = setInterval(() => {
				safeWrite("event: update\ndata:[]\n\n");
			}, 30_000);
			req.on("close", () => {
				clearInterval(heartbeat);
				checkpointEmitter.removeSink(sink);
				instance.unsubscribe(subscriptionID);
			});
		} catch (e: unknown) {
			console.error(e);
			if (e instanceof SkipUnknownCollectionError) res.sendStatus(404);
			else if (e instanceof SkipResourceInstanceInUseError) res.sendStatus(409);
			else res.sendStatus(500);
		}
	});
	streamingApp.get("/healthz", (_req, res) => {
		res.sendStatus(200);
	});

	const controlServer = await listenOrThrow(controlApp, options.controlPort, "control server");
	assertLoopbackListen(controlServer, "control server");

	const streamingServer = await listenOrThrow(streamingApp, options.streamingPort, "streaming server");
	assertLoopbackListen(streamingServer, "streaming server");

	return {
		checkpointEmitter,
		instance,
		close: async () => {
			await new Promise<void>((resolve) => controlServer.close(() => resolve()));
			await new Promise<void>((resolve) => streamingServer.close(() => resolve()));
			await instance.close();
		},
	};
}

export { formatCheckpointFrame };
