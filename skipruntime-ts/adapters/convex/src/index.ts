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
export type ConvexAdapterLogger = { error: (message: string, error: unknown) => void };

export type ConvexExternalServiceOptions = {
  scope: ConvexServiceScope;
  logger?: ConvexAdapterLogger;
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
      `Convex value at ${path} is a bigint (v.int64), which Skip cannot represent. Map it to a string in the Convex query before returning it.`,
    );
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new TypeError(
      `Convex value at ${path} is binary (v.bytes), which Skip cannot represent. Map it to a string in the Convex query before returning it.`,
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    // Convex's v.number() admits NaN and Infinity, which JSON cannot carry and
    // which would turn any sum Skip computes over the field into NaN for good.
    throw new TypeError(
      `Convex value at ${path} is ${String(value)}, which is not valid JSON. Keep non-finite numbers out of the query result.`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => { assertSkipJson(item, `${path}[${index}]`); });
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
      throw new TypeError(`getKey returned ${typeof key} for a Convex row; Skip keys must be strings.`);
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
export class ConvexExternalService<Row extends Json> implements ExternalService {
  private readonly client: ConvexSubscriber;
  private readonly logger: ConvexAdapterLogger;
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    convex: string | ConvexSubscriber,
    private readonly resources: {
      readonly [resourceName: string]: ConvexReactiveResource<Row>;
    },
    private readonly options: ConvexExternalServiceOptions,
  ) {
    this.client = typeof convex === "string" ? new ConvexClient(convex) : convex;
    this.logger = options.logger ?? {
      error: (message, error) => { console.error(message, error); },
    };
  }

  async subscribe(
    instance: string,
    resourceName: string,
    params: Json,
    callbacks: {
      update: (updates: Entry<Json, Json>[], isInitial: boolean) => Promise<void>;
      error: (error: unknown) => void;
    },
  ): Promise<void> {
    const resource = this.resources[resourceName];
    if (resource === undefined) {
      throw new SkipUnknownResourceError(`Unknown Convex resource named '${resourceName}'`);
    }
    if (this.subscriptions.has(instance)) {
      throw new Error(`Convex resource instance '${instance}' is already open`);
    }

    let args: unknown;
    try {
      args = resource.argsFromParams(params, this.options.scope);
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
    let delivery = Promise.resolve();
    let detach: (() => void) | undefined;
    let resolveInitial: () => void;
    let rejectInitial: (error: unknown) => void;
    const initialDelivery = new Promise<void>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });

    const reportError = (error: unknown, sourceGeneration?: number) => {
      if (sourceGeneration !== undefined && sourceGeneration !== generation) {
        return;
      }
      this.logger.error("Convex external service error", error);
      callbacks.error(error);
      if (!initialSettled) rejectInitial(error);
    };

    const resubscribe = () => {
      if (released || reconnecting) return;
      reconnecting = true;
      detach?.();
      current = new Map<string, ConvexSnapshotEntry<Row>>();
      initialQueued = false;
      attach();
      reconnecting = false;
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
          if (isInitial) {
            initialSettled = true;
            resolveInitial();
          }
        })
        .catch((error: unknown) => {
          if (released || sourceGeneration !== generation) return;
          reportError(error, sourceGeneration);
          if (initialSettled) resubscribe();
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
    await this.client.close();
  }
}
