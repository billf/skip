import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import type { Id } from "../../convex/_generated/dataModel.js";
import { api } from "../../convex/_generated/api.js";
import { projectSummaries } from "../skip_collection.js";

const workspaceQuery = convexQuery(api.workspace.snapshot, {});

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(workspaceQuery),
  component: Home,
});

function Home() {
  const { data: workspace } = useSuspenseQuery(workspaceQuery);
  const seed = useMutation({
    mutationFn: useConvexMutation(api.workspace.seed),
  });
  const advance = useMutation({
    mutationFn: useConvexMutation(api.workspace.advanceTask),
  });
  const tasks = workspace
    .filter((row) => row.kind === "task")
    .map((row) => row.task);

  return (
    <main>
      <header>
        <p className="eyebrow">Three reactive layers</p>
        <h1>Convex + Skip + TanStack</h1>
        <p>
          Convex data is server-rendered through React Query, then resumes as a
          live browser subscription. Skip projections enter a TanStack DB
          collection for client-local live queries.
        </p>
      </header>
      {workspace.length === 0 ? (
        <button onClick={() => seed.mutate({})}>Seed example data</button>
      ) : null}
      <div className="grid">
        <article>
          <h2>Convex via TanStack Query</h2>
          <p className="hint">Loader-prefetched, SSR-safe, and still live.</p>
          <ul>
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  className={`status ${task.status}`}
                  onClick={() =>
                    advance.mutate({ taskId: task.id as Id<"tasks"> })
                  }
                >
                  {task.status}
                </button>
                <span>{task.title}</span>
                <small>{task.effort} pts</small>
              </li>
            ))}
          </ul>
        </article>
        <article>
          <h2>Skip via TanStack DB</h2>
          <p className="hint">
            Skip SSE deltas maintain a normalized collection.
          </p>
          <ClientOnly fallback={<p>Connecting after hydration…</p>}>
            <SummaryCollection />
          </ClientOnly>
        </article>
      </div>
    </main>
  );
}

function SummaryCollection() {
  const summaries = useLiveQuery({
    query: (q) =>
      q
        .from({ summary: projectSummaries })
        .orderBy(({ summary }) => summary.openEffort, "desc"),
  });
  if (summaries.isLoading) return <p>Loading Skip…</p>;
  if (summaries.isError)
    return <p className="error">Skip collection failed.</p>;
  return (
    <div className="cards">
      {summaries.data.map((summary) => (
        <div className="card" key={summary.id}>
          <strong>{summary.name}</strong>
          <span>{summary.openTasks} open</span>
          <span>{summary.openEffort} open points</span>
          <small>{summary.totalTasks} total tasks</small>
        </div>
      ))}
    </div>
  );
}
