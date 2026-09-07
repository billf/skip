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

    const apply = (event: MessageEvent<string>, replace: boolean) => {
      const entries = JSON.parse(event.data) as SkipEntry[];
      setRows((current) => {
        const next = replace
          ? new Map<string, ProjectSummary>()
          : new Map(current);
        for (const [key, values] of entries) {
          if (values.length === 0) next.delete(key);
          else if (values.length === 1) next.set(key, values[0]!);
          else throw new Error(`Expected one Skip value for ${key}`);
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

    void (async () => {
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
        // Only a CLOSED socket is fatal; transient drops are retried and clear
        // themselves on the next delivered event.
        if (source?.readyState !== EventSource.CLOSED) return;
        setError(new Error("Skip event stream disconnected"));
      };
    })().catch((reason: unknown) => {
      if (disposed) return;
      setError(reason instanceof Error ? reason : new Error(String(reason)));
      setLoading(false);
    });

    return () => {
      disposed = true;
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
