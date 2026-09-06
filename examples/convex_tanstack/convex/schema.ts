import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  projects: defineTable({ name: v.string() }),
  tasks: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    status: v.union(v.literal("todo"), v.literal("doing"), v.literal("done")),
    effort: v.number(),
  }).index("by_project", ["projectId"]),
});
