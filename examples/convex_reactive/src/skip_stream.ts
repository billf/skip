import { useEffect, useState } from "react";
import type { ProjectSummary } from "../shared/model.js";

type SkipEntry = [string, ProjectSummary[]];

export function useProjectSummaries(): {
  data: ProjectSummary[];
  loading: boolean;
  error: Error | null;
} {
  const [rows, setRows] = useState(new Map<string, ProjectSummary>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    let streamId: string | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const apply = (event: MessageEvent<string>, replace: boolean) => {
      const entries = JSON.parse(event.data) as SkipEntry[];
      // Validate before touching state: React runs the updater below at render
      // time, outside `receive`'s try/catch, so a throw there would unmount the
      // tree instead of reaching the error banner.
      const staged = entries.map(([key, values]) => {
        if (values.length > 1) {
          throw new Error(`Expected one Skip value for ${key}`);
        }
        return [key, values[0]] as const;
      });
      setRows((current) => {
        const next = replace
          ? new Map<string, ProjectSummary>()
          : new Map(current);
        for (const [key, value] of staged) {
          if (value === undefined) next.delete(key);
          else next.set(key, value);
        }
        return next;
      });
      setLoading(false);
      // EventSource reconnects on its own, so a delivered event means the stream
      // recovered -- clear any banner left by the drop that preceded it.
      setError(null);
    };
    const receive = (event: MessageEvent<string>, replace: boolean) => {
      try {
        apply(event, replace);
      } catch (reason) {
        setError(reason instanceof Error ? reason : new Error(String(reason)));
        setLoading(false);
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
      if (!response.ok) throw new Error(`Skip control API: ${response.status}`);
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
        // Only a CLOSED socket is fatal; transient drops are retried by
        // EventSource itself and clear on the next delivered event.
        if (source?.readyState !== EventSource.CLOSED) return;
        // A Skip restart destroys every minted stream id, and EventSource would
        // otherwise retry this dead one forever while the pane silently stops
        // updating. Mint a fresh stream instead; its `init` replaces the rows.
        reconnect();
      };
    };

    const reconnect = () => {
      if (disposed) return;
      source?.close();
      source = undefined;
      // A closed socket can also mean a 409/406/5xx while Skip is healthy, in
      // which case the old instance is still alive server-side and only a
      // DELETE frees it. Best effort: a restarted Skip has already forgotten it.
      const staleId = streamId;
      streamId = undefined;
      if (staleId !== undefined) {
        void fetch(`/skip-control/v1/streams/${staleId}`, {
          method: "DELETE",
        }).catch(() => undefined);
      }
      setError(new Error("Skip event stream disconnected; reconnecting..."));
      // Fixed delay is deliberate: an example should be readable, and a real
      // client wants capped exponential backoff with jitter here.
      retry = setTimeout(() => {
        // A failed re-mint (Skip may still be starting) must schedule another
        // attempt, or the pane stays frozen on stale rows until a reload.
        void connect().catch((reason: unknown) => {
          console.error("Skip stream reconnect failed", reason);
          reconnect();
        });
      }, 1000);
    };

    const fail = (reason: unknown) => {
      if (disposed) return;
      setError(reason instanceof Error ? reason : new Error(String(reason)));
      setLoading(false);
    };

    void connect().catch(fail);

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
  }, []);

  return {
    data: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    loading,
    error,
  };
}
