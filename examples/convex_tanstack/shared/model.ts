export type Project = { id: string; name: string };
export type TaskStatus = "todo" | "doing" | "done";
export type Task = {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  effort: number;
};
export type WorkspaceRow =
  | { key: string; kind: "project"; project: Project }
  | { key: string; kind: "task"; task: Task };
export type ProjectSummary = Project & {
  totalTasks: number;
  openTasks: number;
  openEffort: number;
};
