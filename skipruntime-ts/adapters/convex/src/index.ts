/**
 * A Convex adapter for the Skip runtime.
 *
 * @packageDocumentation
 */

import { isDeepStrictEqual } from "node:util";
import type { Entry, ExternalService, Json } from "@skipruntime/core";
import { SkipUnknownResourceError } from "@skipruntime/core";
import { ConvexClient } from "convex/browser";
import type { FunctionArgs, FunctionReference } from "convex/server";

/** A keyed row retained from the most recently accepted Convex snapshot. */
export type ConvexSnapshotEntry<Row extends Json> = {
  key: string;
  value: Row;
};
type Subscription = { release: () => void; drain: () => Promise<void> };

/** The immutable tenant boundary for one adapter instance. */
export type ConvexServiceScope = Readonly<{ tenantId: string }>;

/**
 * A resource definition with query arguments checked against its concrete
 * Convex function reference. Use {@link defineConvexReactiveResource} to
 * retain that checking when adding it to a heterogeneous resource registry.
 */
export type TypedConvexReactiveResource<
  Row extends Json,
  Query extends FunctionReference<"query">,
> = {
  query: Query;
  getKey: (row: Row) => string;
  argsFromParams: (
    params: Json,
    scope: ConvexServiceScope,
  ) => FunctionArgs<Query>;
};

/** A resource definition after its query-specific Convex arguments are erased. */
export type ConvexReactiveResource<Row extends Json> = {
  query: FunctionReference<"query">;
  getKey: (row: Row) => string;
  argsFromParams: (params: Json, scope: ConvexServiceScope) => unknown;
};

/**
 * Check a resource's named Convex arguments before erasing them for a registry
 * that may contain queries with different argument types.
 *
 * @returns The resource ready for registration with ConvexExternalService.
 */
export function defineConvexReactiveResource<
  Row extends Json,
  Query extends FunctionReference<"query">,
>(
  resource: TypedConvexReactiveResource<Row, Query>,
): ConvexReactiveResource<Row> {
  return resource;
}

/** The small part of ConvexClient required by the adapter. */
export type ConvexSubscriber = Pick<ConvexClient, "onUpdate" | "close">;

/** Where the adapter reports failures. Defaults to console.error. */
export type ConvexAdapterLogger = {
  error: (message: string, error: unknown) => void;
};

export type ConvexExternalServiceOptions = {
  scope: ConvexServiceScope;
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
 * Build a client that waits for the trusted service token before evaluating
 * authenticated queries. Pass the returned client to ConvexExternalService.
 *
 * @returns An authenticated Convex client.
 */
export function createAuthenticatedConvexClient(
  convexUrl: string,
  fetchToken: Parameters<ConvexClient["setAuth"]>[0],
): ConvexClient {
  const client = new ConvexClient(convexUrl, { expectAuth: true });
  client.setAuth(fetchToken);
  return client;
}

/** Reject Convex values that Skip's JSON boundary cannot faithfully represent. */
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
    value.forEach((item, index) => {
      assertSkipJson(item, `${path}[${index}]`);
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
  previous: ReadonlyMap<string, ConvexSnapshotEntry<Row>>,
  rows: readonly Row[],
  getKey: (row: Row) => string,
): {
  next: Map<string, ConvexSnapshotEntry<Row>>;
  updates: Entry<string, Row>[];
} {
  const next = new Map<string, ConvexSnapshotEntry<Row>>();
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
  /**
   * A frozen copy of the caller's scope. `Readonly` is erased at runtime, so
   * retaining the caller's object would let a later mutation of `tenantId`
   * redirect subsequent subscriptions to another tenant.
   */
  private readonly scope: ConvexServiceScope;
  private readonly maxResubscribeAttempts: number;
  private readonly resubscribeBackoffMs: number;
  private readonly closeClient: boolean;

  constructor(
    convex: string | ConvexSubscriber,
    private readonly resources: {
      readonly [resourceName: string]: ConvexReactiveResource<Row>;
    },
    options: ConvexExternalServiceOptions,
  ) {
    const ownsClient = typeof convex === "string";
    this.client = ownsClient ? new ConvexClient(convex) : convex;
    this.logger = options.logger ?? {
      error: (message, error) => {
        console.error(message, error);
      },
    };
    // Typed as required, but this is a published boundary that untyped callers
    // reach, so the check is a runtime one.
    const scopeInput: unknown = options.scope;
    const tenantId =
      typeof scopeInput === "object" && scopeInput !== null
        ? (scopeInput as { tenantId?: unknown }).tenantId
        : undefined;
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new TypeError(
        "ConvexExternalService requires a scope with a non-empty tenantId.",
      );
    }
    this.scope = Object.freeze({ tenantId });
    this.maxResubscribeAttempts = options.maxResubscribeAttempts ?? 5;
    this.resubscribeBackoffMs = options.resubscribeBackoffMs ?? 100;
    this.closeClient = options.closeClient ?? ownsClient;
  }

  async subscribe(
    instance: string,
    resourceName: string,
    params: Json,
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

    let args: unknown;
    try {
      args = resource.argsFromParams(params, this.scope);
    } catch (error) {
      callbacks.error(error);
      throw error;
    }

    let current = new Map<string, ConvexSnapshotEntry<Row>>();
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
      if (sourceGeneration !== undefined && sourceGeneration !== generation) {
        return;
      }
      this.logger.error("Convex external service error", error);
      callbacks.error(error);
      if (!initialSettled && shouldRejectInitial) rejectInitial(error);
    };

    const resubscribe = () => {
      if (released || reconnecting) return;
      if (resubscribeAttempts >= this.maxResubscribeAttempts) {
        // Convex redelivers a cached result as soon as a subscription is
        // re-established, so retrying without a cap against a persistently
        // failing consumer is a hot loop rather than a recovery.
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
        current = new Map<string, ConvexSnapshotEntry<Row>>();
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
      delivery = delivery
        .then(async () => {
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
          // A rejected bootstrap batch is recoverable: retain the pending
          // subscribe call and replace the Convex subscription so a quiet
          // query result is delivered again as a fresh initial snapshot.
          reportError(error, sourceGeneration, false);
          resubscribe();
        });
    };

    const attach = () => {
      const sourceGeneration = generation + 1;
      generation = sourceGeneration;
      const onUpdate = this.client.onUpdate as (
        query: FunctionReference<"query">,
        queryArgs: unknown,
        callback: (rows: Row[]) => unknown,
        onError: (error: Error) => unknown,
      ) => () => void;
      detach = onUpdate(
        resource.query,
        args,
        (rows) => onRows(rows, sourceGeneration),
        (error) => reportError(error, sourceGeneration),
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
