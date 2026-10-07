import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { ProjectSummary } from "../shared/model.js";
import { projectSummaries } from "../src/skip_collection.js";

type Listener = (event: MessageEvent<string>) => void;

/** Just enough EventSource for the sync function to drive. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = 1;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Deliver one Skip batch: `[key, values][]`, an empty `values` deletes. */
  emit(type: "init" | "update", entries: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(entries) } as MessageEvent<string>);
    }
  }
}

type SyncParams = Parameters<typeof projectSummaries.config.sync.sync>[0];
type Write = Parameters<SyncParams["write"]>[0];

const summary = (id: string, totalTasks = 0): ProjectSummary => ({
  id,
  name: `project ${id}`,
  totalTasks,
  openTasks: totalTasks,
  openEffort: totalTasks * 2,
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;
const realConsoleError = console.error;
let errors: unknown[][];
let stopSync: (() => void) | undefined;

beforeEach(() => {
  FakeEventSource.instances = [];
  errors = [];
  console.error = (...args: unknown[]) => void errors.push(args);
  globalThis.fetch = (async (_url: unknown, init?: { method?: string }) =>
    new Response(init?.method === "POST" ? "stream-1" : null)) as typeof fetch;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  stopSync?.();
  stopSync = undefined;
  console.error = realConsoleError;
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});

/**
 * Run the collection's real sync function against a recording stand-in for
 * TanStack DB's sync API, and hand back the fake stream it opened. `calls` is
 * the exact sequence of API calls the sync function made.
 */
async function startSync(options?: { commit?: () => true | Promise<void> }) {
  const calls: string[] = [];
  const commit = { run: options?.commit ?? (() => true as const) };
  const params = {
    begin: () => void calls.push("begin"),
    truncate: () => void calls.push("truncate"),
    write: (message: Write) =>
      void calls.push(
        message.type === "delete"
          ? `delete:${String(message.key)}`
          : `${message.type}:${(message.value as ProjectSummary).id}`,
      ),
    commit: () => {
      calls.push("commit");
      return commit.run();
    },
    markReady: () => void calls.push("ready"),
    markError: () => void calls.push("error"),
  };

  const cleanup = projectSummaries.config.sync.sync(params as never);
  stopSync = typeof cleanup === "function" ? cleanup : cleanup.cleanup;
  while (FakeEventSource.instances.length === 0) await tick();
  return { calls, source: FakeEventSource.instances[0]!, commit };
}

test("an init snapshot truncates, then writes every row in one transaction", async () => {
  const { calls, source } = await startSync();

  source.emit("init", [
    ["p1", [summary("p1", 1)]],
    ["p2", [summary("p2", 2)]],
  ]);

  assert.deepEqual(calls, [
    "begin",
    "truncate",
    "insert:p1",
    "insert:p2",
    "commit",
    "ready",
  ]);
});

test("updates insert unseen keys, update known keys and delete emptied ones", async () => {
  const { calls, source } = await startSync();
  source.emit("init", [["p1", [summary("p1", 1)]]]);
  calls.length = 0;

  source.emit("update", [
    ["p1", [summary("p1", 5)]],
    ["p2", [summary("p2", 2)]],
  ]);
  source.emit("update", [["p1", []]]);
  // The delete has to reach the mirror, or this re-add is sent as an update for
  // a key the collection no longer has.
  source.emit("update", [["p1", [summary("p1", 7)]]]);

  assert.deepEqual(calls, [
    "begin",
    "update:p1",
    "insert:p2",
    "commit",
    "begin",
    "delete:p1",
    "commit",
    "begin",
    "insert:p1",
    "commit",
  ]);
  assert.deepEqual(errors, []);
});

test("a malformed update is rejected whole, before any transaction opens", async () => {
  const { calls, source } = await startSync();
  source.emit("init", [["p1", [summary("p1", 1)]]]);
  calls.length = 0;

  // p1 is valid and comes first: were entries checked as they were written, p1
  // would already be in a transaction by the time p2 aborts the batch, and a
  // transaction that is begun but never committed is never retired.
  source.emit("update", [
    ["p1", [summary("p1", 9)]],
    ["p2", [summary("p2", 1), summary("p2", 2)]],
  ]);

  assert.deepEqual(calls, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.[0], "Invalid Skip update");

  // The mirror did not move either: the same keys apply normally next time,
  // with p2 still an insert.
  source.emit("update", [
    ["p1", [summary("p1", 9)]],
    ["p2", [summary("p2", 2)]],
  ]);
  assert.deepEqual(calls, ["begin", "update:p1", "insert:p2", "commit"]);
});

test("a malformed first snapshot is a collection error, not a partial load", async () => {
  const { calls, source } = await startSync();

  source.emit("init", [
    ["p1", [summary("p1", 1)]],
    ["p2", [summary("p2", 1), summary("p2", 2)]],
  ]);

  assert.deepEqual(calls, ["error"]);
  assert.deepEqual(errors, []);
});

test("a fresh init resets the mirror along with the rows", async () => {
  const { calls, source } = await startSync();
  source.emit("init", [
    ["p1", [summary("p1", 1)]],
    ["p2", [summary("p2", 2)]],
  ]);
  calls.length = 0;

  // A re-minted stream (after Skip restarts) opens with a new `init`.
  source.emit("init", [["p3", [summary("p3", 3)]]]);
  source.emit("update", [
    ["p1", [summary("p1", 4)]],
    ["p3", [summary("p3", 6)]],
  ]);

  assert.deepEqual(calls, [
    "begin",
    "truncate",
    "insert:p3",
    "commit",
    "ready",
    "begin",
    "insert:p1",
    "update:p3",
    "commit",
  ]);
});

test("the mirror only advances once the batch has committed", async () => {
  const { calls, source, commit } = await startSync();
  source.emit("init", [["p1", [summary("p1", 1)]]]);
  calls.length = 0;

  commit.run = () => {
    throw new Error("commit failed");
  };
  source.emit("update", [["p2", [summary("p2", 2)]]]);
  assert.equal(errors.length, 1);

  // p2 never reached the collection, so it is still an insert.
  commit.run = () => true;
  source.emit("update", [["p2", [summary("p2", 2)]]]);
  assert.deepEqual(calls, [
    "begin",
    "insert:p2",
    "commit",
    "begin",
    "insert:p2",
    "commit",
  ]);
});

test("a commit receipt that rejects is not an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { calls, source, commit } = await startSync();
    source.emit("init", [["p1", [summary("p1", 1)]]]);
    calls.length = 0;

    // TanStack DB rejects the receipt with AbortError when it abandons the
    // transaction during cleanup; that discards this closure and its mirror.
    commit.run = () => Promise.reject(new Error("AbortError"));
    source.emit("update", [["p1", [summary("p1", 2)]]]);
    await tick();

    assert.deepEqual(unhandled, []);
    assert.deepEqual(calls, ["begin", "update:p1", "commit"]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
