import { createCollection } from "@tanstack/db";
import type { CollectionConfig } from "@tanstack/db";
import type { ProjectSummary } from "../shared/model.js";

type SkipEntry = [string, ProjectSummary[]];

const config: CollectionConfig<ProjectSummary, string> = {
  id: "skip-project-summaries",
  getKey: (summary) => summary.id,
  sync: {
    rowUpdateMode: "full",
    sync: ({ begin, write, commit, truncate, markReady, markError }) => {
      let disposed = false;
      let source: EventSource | undefined;
      let streamId: string | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let ready = false;
      const current = new Map<string, ProjectSummary>();

      const apply = (event: MessageEvent<string>, initial: boolean) => {
        const entries = JSON.parse(event.data) as SkipEntry[];
        // Validate the whole batch before opening a transaction. A throw between
        // begin() and commit() would strand the transaction in TanStack DB's
        // pending queue -- it only retires committed ones -- and leave `current`
        // describing rows the collection never received.
        const staged = entries.map(([key, values]) => {
          if (values.length > 1) {
            throw new Error(`Expected one Skip value for ${key}`);
          }
          return { key, value: values[0] };
        });

        begin();
        if (initial) {
          truncate();
          current.clear();
        }
        for (const { key, value } of staged) {
          if (value === undefined) write({ type: "delete", key });
          else write({ type: current.has(key) ? "update" : "insert", value });
        }
        const applied = commit();
        // Mirror the batch only once it is committed, so `current` never gets
        // ahead of the collection. commit() applies synchronously and returns
        // either `true` or a promise for downstream settling.
        if (applied !== true) applied.catch(() => {});
        for (const { key, value } of staged) {
          if (value === undefined) current.delete(key);
          else current.set(key, value);
        }
        if (initial) {
          ready = true;
          markReady();
        }
      };
      const receive = (event: MessageEvent<string>, initial: boolean) => {
        try {
          apply(event, initial);
        } catch (error) {
          if (ready) console.error("Invalid Skip update", error);
          else markError(error);
        }
      };

      const connect = async (): Promise<void> => {
        const response = await fetch(
          "/skip-control/v1/streams/projectSummaries",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        if (!response.ok)
          throw new Error(`Skip control API: ${response.status}`);
        streamId = await response.text();
        if (disposed) {
          await fetch(`/skip-control/v1/streams/${streamId}`, {
            method: "DELETE",
          });
          return;
        }
        source = new EventSource(`/skip-stream/v1/streams/${streamId}`);
        source.addEventListener("init", (event) => receive(event, true));
        source.addEventListener("update", (event) => receive(event, false));
        source.onerror = () => {
          // EventSource retries on its own; only a CLOSED socket is fatal. A
          // Skip restart destroys every minted stream id, so this one now 404s
          // and would be retried forever while the collection silently served
          // stale rows with isError false. Mint a fresh stream instead; its
          // `init` truncates and repopulates the collection.
          if (source?.readyState !== EventSource.CLOSED) return;
          reconnect();
        };
      };

      const reconnect = () => {
        if (disposed) return;
        source?.close();
        source = undefined;
        streamId = undefined;
        // Fixed delay is deliberate: an example should be readable, and a real
        // client wants capped exponential backoff with jitter here.
        retry = setTimeout(() => {
          void connect().catch(onFailure);
        }, 1000);
      };

      const onFailure = (error: unknown) => {
        if (disposed) return;
        // Before the collection is ready a failure is terminal for preload();
        // after it, the rows already on screen stay usable while we retry.
        if (ready) console.error("Skip stream failed", error);
        else markError(error);
      };

      void connect().catch(onFailure);

      return () => {
        disposed = true;
        if (retry !== undefined) clearTimeout(retry);
        source?.close();
        if (streamId !== undefined) {
          void fetch(`/skip-control/v1/streams/${streamId}`, {
            method: "DELETE",
          });
        }
      };
    },
  },
};

export const projectSummaries = createCollection(config);
