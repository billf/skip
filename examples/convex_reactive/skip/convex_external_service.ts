import { isDeepStrictEqual } from "node:util";
import type { Entry, ExternalService, Json } from "@skipruntime/core";
import { SkipUnknownResourceError } from "@skipruntime/core";
import { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type { Value } from "convex/values";

type SnapshotEntry<Row extends Json> = { key: string; value: Row };

type Subscription = { release: () => void; drain: () => Promise<void> };

export type ConvexReactiveResource<Row extends Json> = {
  query: FunctionReference<"query">;
  args: Record<string, Value>;
  getKey: (row: Row) => string;
};

/**
 * The part of `ConvexClient` this adapter uses. Accepting the interface rather
 * than the class lets the subscription lifecycle be tested without a
 * deployment.
 */
export type ConvexSubscriber = Pick<ConvexClient, "onUpdate" | "close">;

/** Where the adapter reports failures. Defaults to `console`. */
export type ConvexAdapterLogger = { error: (message: string, error: unknown) => void };

export type ConvexExternalServiceOptions = { logger?: ConvexAdapterLogger };

/**
 * Convex's `Value` domain is wider than Skip's `Json`: `v.int64()` yields a
 * `bigint` and `v.bytes()` an `ArrayBuffer`. Neither survives the boundary --
 * Skip's `exportJSON` throws an opaque wasm error on a bigint and silently
 * exports an ArrayBuffer as `{}`, which would reach the graph as real data
 * loss. Reject both here, named, so the failure is legible.
 */
export function assertSkipJson(value: unknown, path = "row"): void {
  if (typeof value === "bigint") {
    throw new TypeError(
      `Convex value at ${path} is a bigint (v.int64), which Skip cannot represent. Supply a row encoder that maps it to a string.`,
    );
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new TypeError(
      `Convex value at ${path} is binary (v.bytes), which Skip cannot represent. Supply a row encoder that maps it to a string.`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => { assertSkipJson(item, `${path}[${i}]`); });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertSkipJson(item, `${path}.${key}`);
    }
  }
}

export function diffSnapshot<Row extends Json>(
  previous: ReadonlyMap<string, SnapshotEntry<Row>>,
  rows: readonly Row[],
  getKey: (row: Row) => string,
): { next: Map<string, SnapshotEntry<Row>>; updates: Entry<string, Row>[] } {
  const next = new Map<string, SnapshotEntry<Row>>();
  const updates: Entry<string, Row>[] = [];

  for (const row of rows) {
    assertSkipJson(row);
    const key = getKey(row);
    if (typeof key !== "string") {
      throw new TypeError(
        `getKey returned ${typeof key} for a Convex row; Skip keys must be strings.`,
      );
    }
    if (next.has(key)) throw new Error(`Duplicate Convex snapshot key: ${key}`);
    next.set(key, { key, value: row });
    const old = previous.get(key);
    // Structural comparison, not JSON.stringify: serialising is sensitive to
    // key order, so a row rebuilt by spread or with reordered fields would be
    // reported as changed on every snapshot even when nothing moved.
    if (old === undefined || !isDeepStrictEqual(old.value, row)) {
      updates.push([key, [row]]);
    }
  }
  for (const old of previous.values()) {
    if (!next.has(old.key)) updates.push([old.key, []]);
  }
  return { next, updates };
}

/** Bridges full, reactive Convex query snapshots into keyed Skip deltas. */
export class ConvexExternalService<Row extends Json>
  implements ExternalService
{
  private readonly client: ConvexSubscriber;
  private readonly logger: ConvexAdapterLogger;
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    convex: string | ConvexSubscriber,
    private readonly resources: Record<string, ConvexReactiveResource<Row>>,
    options: ConvexExternalServiceOptions = {},
  ) {
    this.client =
      typeof convex === "string" ? new ConvexClient(convex) : convex;
    // A library should not own a logging policy; console is only the default.
    this.logger = options.logger ?? {
      error: (message, error) => { console.error(message, error); },
    };
  }

  async subscribe(
    instance: string,
    resourceName: string,
    _params: Json,
    callbacks: {
      update: (
        updates: Entry<Json, Json>[],
        isInitial: boolean,
      ) => Promise<void>;
      error: (error: unknown) => void;
    },
  ): Promise<void> {
    const resource = this.resources[resourceName];
    if (resource === undefined) {
      throw new SkipUnknownResourceError(
        `Unknown Convex resource named '${resourceName}'`,
      );
    }
    if (this.subscriptions.has(instance)) {
      throw new Error(`Convex resource instance '${instance}' is already open`);
    }

    let current = new Map<string, SnapshotEntry<Row>>();
    let initialQueued = false;
    let initialSettled = false;
    let released = false;
    let reconnecting = false;
    let delivery = Promise.resolve();
    let detach: (() => void) | undefined;
    let resolveInitial: () => void;
    let rejectInitial: (error: unknown) => void;
    const initialDelivery = new Promise<void>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });

    const reportError = (error: unknown) => {
      // Skip binds an external service's error channel to a no-op, so log here
      // or the failure leaves no trace at all.
      this.logger.error("Convex external service error", error);
      callbacks.error(error);
      if (!initialSettled) rejectInitial(error);
    };

    // Convex re-delivers a query result only when its read set changes, so a
    // rejected batch is NOT recovered by waiting: on a dataset that then goes
    // quiet the projection would stay stale forever. Tear the subscription down
    // and re-establish it, resetting the mirror so the next delivery is a full
    // initial batch Skip can accept from scratch.
    const resubscribe = () => {
      if (released || reconnecting) return;
      reconnecting = true;
      detach?.();
      current = new Map();
      initialQueued = false;
      attach();
      reconnecting = false;
    };

    const onRows = (rows: Row[]) => {
      const isInitial = !initialQueued;
      initialQueued = true;
      // Diff and advance `current` inside the delivery chain: the mirror must
      // only move to a snapshot Skip actually accepted.
      delivery = delivery
        .then(async () => {
          // Skip tore this instance down while the batch was queued behind an
          // in-flight delivery. Dropping it is correct; reporting it as an
          // error would fire on every clean teardown under load.
          if (released) return;
          const result = diffSnapshot(current, rows, resource.getKey);
          await callbacks.update(result.updates, isInitial);
          current = result.next;
          if (isInitial) {
            initialSettled = true;
            resolveInitial();
          }
        })
        .catch((error: unknown) => {
          if (released) return;
          reportError(error);
          if (initialSettled) resubscribe();
        });
    };

    const attach = () => {
      detach = this.client.onUpdate(
        resource.query,
        resource.args,
        onRows,
        reportError,
      );
    };

    attach();
    this.subscriptions.set(instance, {
      release: () => {
        released = true;
        detach?.();
      },
      drain: () => delivery,
    });
    try {
      await initialDelivery;
    } catch (error) {
      this.subscriptions.get(instance)?.release();
      this.subscriptions.delete(instance);
      throw error;
    }
  }

  unsubscribe(instance: string): void {
    // The ExternalService contract makes this synchronous, so the in-flight
    // delivery chain cannot be awaited here. Marking the instance released is
    // what keeps a queued update from reaching a collection Skip already
    // destroyed; shutdown() does the awaiting.
    this.subscriptions.get(instance)?.release();
    this.subscriptions.delete(instance);
  }

  async shutdown(): Promise<void> {
    const draining = [...this.subscriptions.values()].map((subscription) => {
      subscription.release();
      return subscription.drain();
    });
    this.subscriptions.clear();
    await Promise.allSettled(draining);
    await this.client.close();
  }
}
