import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "../convex/_generated/dataModel.js";
import { api } from "../convex/_generated/api.js";
import type { Project, Task, WorkspaceRow } from "../shared/model.js";
import { useProjectSummaries } from "./skip_stream.js";

export default function App() {
  const workspace = useQuery(api.workspace.snapshot, {}) as
    | WorkspaceRow[]
    | undefined;
  const seed = useMutation(api.workspace.seed);
  const addTask = useMutation(api.workspace.addTask);
  const advanceTask = useMutation(api.workspace.advanceTask);
  const summaries = useProjectSummaries();
  const [title, setTitle] = useState("");
  const [effort, setEffort] = useState(3);

  const projects = useMemo(
    () =>
      workspace
        ?.filter(
          (row): row is { key: string; kind: "project"; project: Project } =>
            row.kind === "project",
        )
        .map((row) => row.project) ?? [],
    [workspace],
  );
  const tasks = useMemo(
    () =>
      workspace
        ?.filter(
          (row): row is { key: string; kind: "task"; task: Task } =>
            row.kind === "task",
        )
        .map((row) => row.task) ?? [],
    [workspace],
  );
  const [selectedProject, setSelectedProject] = useState("");
  const projectId = selectedProject || projects[0]?.id || "";

  return (
    <main>
      <header>
        <p className="eyebrow">Reactive pipeline</p>
        <h1>Convex → Skip → React</h1>
        <p>
          Convex owns transactions and persistence. Skip incrementally maintains
          the per-project workload projection.
        </p>
      </header>

      {workspace?.length === 0 ? (
        <button onClick={() => void seed({})}>Seed example data</button>
      ) : null}

      <section className="grid">
        <article>
          <h2>Convex source</h2>
          <p className="hint">A native useQuery subscription.</p>
          {workspace === undefined ? <p>Loading Convex…</p> : null}
          <ul>
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  className={`status ${task.status}`}
                  onClick={() =>
                    void advanceTask({ taskId: task.id as Id<"tasks"> })
                  }
                >
                  {task.status}
                </button>
                <span>{task.title}</span>
                <small>{task.effort} pts</small>
              </li>
            ))}
          </ul>
          {projects.length > 0 ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (projectId === "" || title.trim() === "") return;
                void addTask({
                  projectId: projectId as Id<"projects">,
                  title: title.trim(),
                  effort,
                });
                setTitle("");
              }}
            >
              <select
                value={projectId}
                onChange={(event) => setSelectedProject(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <input
                aria-label="Task title"
                placeholder="New task"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <input
                aria-label="Effort"
                min={1}
                max={13}
                type="number"
                value={effort}
                onChange={(event) => setEffort(Number(event.target.value))}
              />
              <button type="submit">Add</button>
            </form>
          ) : null}
        </article>

        <article>
          <h2>Skip projection</h2>
          <p className="hint">
            A Skip SSE resource derived from the same snapshot.
          </p>
          {summaries.loading ? <p>Loading Skip…</p> : null}
          {summaries.error !== null ? (
            <p className="error">{summaries.error.message}</p>
          ) : null}
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
        </article>
      </section>
    </main>
  );
}
