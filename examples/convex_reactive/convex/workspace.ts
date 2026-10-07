import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const snapshot = query({
  args: {},
  handler: async (ctx) => {
    const [projects, tasks] = await Promise.all([
      ctx.db.query("projects").collect(),
      ctx.db.query("tasks").collect(),
    ]);

    return [
      ...projects.map((project) => ({
        key: `project:${project._id}`,
        kind: "project" as const,
        project: { id: project._id, name: project.name },
      })),
      ...tasks.map((task) => ({
        key: `task:${task._id}`,
        kind: "task" as const,
        task: {
          id: task._id,
          projectId: task.projectId,
          title: task.title,
          status: task.status,
          effort: task.effort,
        },
      })),
    ];
  },
});

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    if ((await ctx.db.query("projects").first()) !== null) return;

    const launch = await ctx.db.insert("projects", { name: "Launch" });
    const reliability = await ctx.db.insert("projects", {
      name: "Reliability",
    });
    await Promise.all([
      ctx.db.insert("tasks", {
        projectId: launch,
        title: "Write release notes",
        status: "doing",
        effort: 3,
      }),
      ctx.db.insert("tasks", {
        projectId: launch,
        title: "Publish packages",
        status: "todo",
        effort: 5,
      }),
      ctx.db.insert("tasks", {
        projectId: reliability,
        title: "Exercise reconnect path",
        status: "todo",
        effort: 8,
      }),
    ]);
  },
});

export const addTask = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    effort: v.number(),
  },
  handler: async (ctx, args) => {
    // `v.number()` accepts NaN and Infinity, and the form's min/max are enforced
    // only in the browser. The deployment URL ships in the bundle, so anyone can
    // call this mutation directly; keep the value within what the UI offers.
    if (!Number.isInteger(args.effort) || args.effort < 1 || args.effort > 13) {
      throw new Error("Effort must be a whole number from 1 to 13");
    }
    if ((await ctx.db.get("projects", args.projectId)) === null) {
      throw new Error("Project does not exist");
    }
    return await ctx.db.insert("tasks", { ...args, status: "todo" });
  },
});

export const advanceTask = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get("tasks", taskId);
    if (task === null) throw new Error("Task does not exist");
    const status =
      task.status === "todo"
        ? "doing"
        : task.status === "doing"
          ? "done"
          : "todo";
    await ctx.db.patch("tasks", taskId, { status });
  },
});
