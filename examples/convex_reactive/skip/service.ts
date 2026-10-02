import type {
  Context,
  EagerCollection,
  Mapper,
  Reducer,
  Resource,
  SkipService,
  Values,
} from "@skipruntime/core";
import { api } from "../convex/_generated/api.js";
import type {
  Project,
  ProjectSummary,
  Task,
  WorkspaceRow,
} from "../shared/model.js";
import { ConvexExternalService } from "./convex_external_service.js";

type TaskTotals = {
  totalTasks: number;
  openTasks: number;
  openEffort: number;
};

const emptyTotals: TaskTotals = {
  totalTasks: 0,
  openTasks: 0,
  openEffort: 0,
};

class ProjectsOnly implements Mapper<string, WorkspaceRow, string, Project> {
  mapEntry(
    _key: string,
    rows: Values<WorkspaceRow>,
  ): Iterable<[string, Project]> {
    const row = rows.getUnique();
    return row.kind === "project" ? [[row.project.id, row.project]] : [];
  }
}

class TasksOnly implements Mapper<string, WorkspaceRow, string, Task> {
  mapEntry(_key: string, rows: Values<WorkspaceRow>): Iterable<[string, Task]> {
    const row = rows.getUnique();
    return row.kind === "task" ? [[row.task.id, row.task]] : [];
  }
}

class TasksByProject implements Mapper<string, Task, string, TaskTotals> {
  mapEntry(_key: string, tasks: Values<Task>): Iterable<[string, TaskTotals]> {
    const task = tasks.getUnique();
    const open = task.status === "done" ? 0 : 1;
    return [
      [
        task.projectId,
        {
          totalTasks: 1,
          openTasks: open,
          openEffort: open * task.effort,
        },
      ],
    ];
  }
}

class AddTaskTotals implements Reducer<TaskTotals, TaskTotals> {
  initial = emptyTotals;

  add(accum: TaskTotals | null, value: TaskTotals): TaskTotals {
    const current = accum ?? emptyTotals;
    return {
      totalTasks: current.totalTasks + value.totalTasks,
      openTasks: current.openTasks + value.openTasks,
      openEffort: current.openEffort + value.openEffort,
    };
  }

  remove(accum: TaskTotals, value: TaskTotals): TaskTotals {
    return {
      totalTasks: accum.totalTasks - value.totalTasks,
      openTasks: accum.openTasks - value.openTasks,
      openEffort: accum.openEffort - value.openEffort,
    };
  }
}

class AttachTotals implements Mapper<string, Project, string, ProjectSummary> {
  constructor(private readonly totals: EagerCollection<string, TaskTotals>) {}

  mapEntry(
    key: string,
    projects: Values<Project>,
  ): Iterable<[string, ProjectSummary]> {
    const project = projects.getUnique();
    const totals = this.totals.getUnique(key, { ifNone: emptyTotals });
    return [
      [
        key,
        {
          id: project.id,
          name: project.name,
          totalTasks: totals.totalTasks,
          openTasks: totals.openTasks,
          openEffort: totals.openEffort,
        },
      ],
    ];
  }
}

type Graph = {
  projectSummaries: EagerCollection<string, ProjectSummary>;
};

class ProjectSummariesResource implements Resource<Graph> {
  instantiate(graph: Graph): EagerCollection<string, ProjectSummary> {
    return graph.projectSummaries;
  }
}

export function createService(convexUrl: string): SkipService<{}, Graph> {
  const convex = new ConvexExternalService<WorkspaceRow>(convexUrl, {
    workspace: {
      query: api.workspace.snapshot,
      args: {},
      getKey: (row) => row.key,
    },
  });

  return {
    initialData: {},
    resources: { projectSummaries: ProjectSummariesResource },
    externalServices: { convex },
    createGraph(_inputs: {}, context: Context): Graph {
      const workspace = context.useExternalResource<string, WorkspaceRow>({
        service: "convex",
        identifier: "workspace",
        params: {},
      });
      const projects = workspace.map(ProjectsOnly);
      const totals = workspace
        .map(TasksOnly)
        .map(TasksByProject)
        .reduce(AddTaskTotals);
      return { projectSummaries: projects.map(AttachTotals, totals) };
    },
  };
}
