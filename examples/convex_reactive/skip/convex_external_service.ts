import type { Entry, ExternalService, Json } from "@skipruntime/core";
import { SkipUnknownResourceError } from "@skipruntime/core";
import { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type { Value } from "convex/values";

type SnapshotEntry<Row extends Json> = { key: string; value: Row };

export type ConvexReactiveResource<Row extends Json> = {
  query: FunctionReference<"query">;
  args: Record<string, Value>;
  getKey: (row: Row) => string;
};

export function diffSnapshot<Row extends Json>(
  previous: ReadonlyMap<string, SnapshotEntry<Row>>,
  rows: readonly Row[],
  getKey: (row: Row) => string,
): { next: Map<string, SnapshotEntry<Row>>; updates: Entry<string, Row>[] } {
  const next = new Map<string, SnapshotEntry<Row>>();
  const updates: Entry<string, Row>[] = [];

  for (const row of rows) {
    const key = getKey(row);
    if (next.has(key)) throw new Error(`Duplicate Convex snapshot key: ${key}`);
    next.set(key, { key, value: row });
    const old = previous.get(key);
    if (
      old === undefined ||
      JSON.stringify(old.value) !== JSON.stringify(row)
    ) {
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
  private readonly client: ConvexClient;
  private readonly subscriptions = new Map<string, () => void>();

  constructor(
    convexUrl: string,
    private readonly resources: Record<string, ConvexReactiveResource<Row>>,
  ) {
    this.client = new ConvexClient(convexUrl);
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
    let delivery = Promise.resolve();
    let resolveInitial: () => void;
    let rejectInitial: (error: unknown) => void;
    const initialDelivery = new Promise<void>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    const reportError = (error: unknown) => {
      // Skip binds an external service's error channel to a no-op, so log here
      // or the failure leaves no trace at all.
      console.error("Convex external service error", error);
      callbacks.error(error);
      if (!initialSettled) rejectInitial(error);
    };
    const unsubscribe = this.client.onUpdate(
      resource.query,
      resource.args,
      (rows: Row[]) => {
        const isInitial = !initialQueued;
        initialQueued = true;
        // Diff and advance `current` inside the delivery chain: the mirror must
        // only move to a snapshot Skip actually accepted, or a rejected batch is
        // never retransmitted and the projection stays stale forever.
        delivery = delivery
          .then(async () => {
            const result = diffSnapshot(current, rows, resource.getKey);
            await callbacks.update(result.updates, isInitial);
            current = result.next;
            if (isInitial) {
              initialSettled = true;
              resolveInitial();
            }
          })
          .catch(reportError);
      },
      reportError,
    );
    this.subscriptions.set(instance, unsubscribe);
    try {
      await initialDelivery;
    } catch (error) {
      unsubscribe();
      this.subscriptions.delete(instance);
      throw error;
    }
  }

  unsubscribe(instance: string): void {
    this.subscriptions.get(instance)?.();
    this.subscriptions.delete(instance);
  }

  async shutdown(): Promise<void> {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    await this.client.close();
  }
}
