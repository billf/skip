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
export type ConvexAdapterLogger = {
  error: (message: string, error: unknown) => void;
};

export type ConvexExternalServiceOptions = {
  logger?: ConvexAdapterLogger;
  /**
   * Consecutive failed recoveries before a subscription stops retrying and
   * goes inert. Convex redelivers a cached result as soon as a subscription is
   * re-established, so an uncapped retry against a persistently failing Skip
   * saturates the event loop. Defaults to 5.
   */
  maxResubscribeAttempts?: number;
  /**
   * Base delay in milliseconds between recovery attempts, doubled on each
   * consecutive failure. Defaults to 100.
   */
  resubscribeBackoffMs?: number;
  /**
   * Whether `shutdown` closes the Convex client. Defaults to true when this
   * service constructed the client from a URL, and false when a client was
   * injected, since an injected client belongs to the caller and may be shared.
   */
  closeClient?: boolean;
};

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
    value.forEach((item, i) => {
      assertSkipJson(item, `${path}[${i}]`);
    });
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
  private readonly maxResubscribeAttempts: number;
  private readonly resubscribeBackoffMs: number;
  private readonly closeClient: boolean;

  constructor(
    convex: string | ConvexSubscriber,
    private readonly resources: Record<string, ConvexReactiveResource<Row>>,
    options: ConvexExternalServiceOptions = {},
  ) {
    const ownsClient = typeof convex === "string";
    this.client = ownsClient ? new ConvexClient(convex) : convex;
    // A library should not own a logging policy; console is only the default.
    this.logger = options.logger ?? {
      error: (message, error) => {
        console.error(message, error);
      },
    };
    this.maxResubscribeAttempts = options.maxResubscribeAttempts ?? 5;
    this.resubscribeBackoffMs = options.resubscribeBackoffMs ?? 100;
    // An injected client belongs to the caller and may be shared, so only
    // close what this service itself opened unless the caller overrides it.
    this.closeClient = options.closeClient ?? ownsClient;
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
    let generation = 0;
    let resubscribeAttempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let delivery = Promise.resolve();
    let detach: (() => void) | undefined;
    let resolveInitial: () => void;
    let rejectInitial: (error: unknown) => void;
    const initialDelivery = new Promise<void>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });

    const reportError = (
      error: unknown,
      sourceGeneration?: number,
      shouldRejectInitial = true,
    ) => {
      // A generation-tagged error from a subscription this instance already
      // replaced is stale, not new information.
      if (sourceGeneration !== undefined && sourceGeneration !== generation) {
        return;
      }
      // Skip binds an external service's error channel to a no-op, so log here
      // or the failure leaves no trace at all.
      this.logger.error("Convex external service error", error);
      callbacks.error(error);
      if (!initialSettled && shouldRejectInitial) rejectInitial(error);
    };

    // Convex re-delivers a query result only when its read set changes, so a
    // rejected batch is NOT recovered by waiting: on a dataset that then goes
    // quiet the projection would stay stale forever. Tear the subscription down
    // and re-establish it, resetting the mirror so the next delivery is a full
    // initial batch Skip can accept from scratch.
    //
    // ConvexClient.onUpdate re-runs its callback almost immediately when a
    // result is already cached, so retrying without a cap or backoff against a
    // persistently failing consumer turns "recovery" into a hot loop that
    // starves the event loop.
    const resubscribe = () => {
      if (released || reconnecting) return;
      if (resubscribeAttempts >= this.maxResubscribeAttempts) {
        released = true;
        detach?.();
        reportError(
          new Error(
            `Convex resource instance '${instance}' stopped after ${this.maxResubscribeAttempts.toString()} failed recoveries and is now inert. Unsubscribe and subscribe again to retry.`,
          ),
        );
        return;
      }
      const delay = this.resubscribeBackoffMs * 2 ** resubscribeAttempts;
      resubscribeAttempts += 1;
      reconnecting = true;
      detach?.();
      // Discard anything still queued from the subscription being replaced.
      generation += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (released) return;
        current = new Map();
        initialQueued = false;
        attach();
        reconnecting = false;
      }, delay);
      // Never hold the process open for a recovery that nothing is awaiting.
      retryTimer.unref();
    };

    const onRows = (rows: Row[], sourceGeneration: number) => {
      if (sourceGeneration !== generation) return;
      const isInitial = !initialQueued;
      initialQueued = true;
      // Diff and advance `current` inside the delivery chain: the mirror must
      // only move to a snapshot Skip actually accepted.
      delivery = delivery
        .then(async () => {
          // Skip tore this instance down, or a recovery replaced this
          // subscription, while the batch was queued behind an in-flight
          // delivery. Dropping it is correct; reporting it as an error would
          // fire on every clean teardown under load.
          if (released || sourceGeneration !== generation) return;
          const result = diffSnapshot(current, rows, resource.getKey);
          await callbacks.update(result.updates, isInitial);
          current = result.next;
          // A delivery Skip accepted means the consumer is healthy again, so
          // the next failure starts a fresh backoff rather than inheriting one.
          resubscribeAttempts = 0;
          if (isInitial) {
            initialSettled = true;
            resolveInitial();
          }
        })
        .catch((error: unknown) => {
          if (released || sourceGeneration !== generation) return;
          // A rejected initial batch is recoverable just like a later one:
          // retain the pending subscribe call and replace the Convex
          // subscription so a quiet query result is delivered again.
          reportError(error, sourceGeneration, false);
          resubscribe();
        });
    };

    const attach = () => {
      const sourceGeneration = generation + 1;
      generation = sourceGeneration;
      detach = this.client.onUpdate(
        resource.query,
        resource.args,
        (rows) => {
          onRows(rows, sourceGeneration);
        },
        (error) => {
          reportError(error, sourceGeneration);
        },
      );
    };

    attach();
    this.subscriptions.set(instance, {
      release: () => {
        released = true;
        if (retryTimer !== undefined) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
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
    if (this.closeClient) await this.client.close();
  }
}
