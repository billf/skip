import assert from "node:assert/strict";
import test from "node:test";
import type { Values } from "@skipruntime/core";
import type { Task } from "../shared/model.js";
import type { TaskTotals } from "./service.js";
import { AddTaskTotals, TasksByProject, emptyTotals } from "./service.js";

/** Skip only ever calls getUnique() on these mappers' inputs. */
function only<T>(value: T): Values<T> {
  return { getUnique: () => value } as unknown as Values<T>;
}

const task = (status: Task["status"], effort: number): Task => ({
  id: "t1",
  projectId: "p1",
  title: "task",
  status,
  effort,
});

test("AddTaskTotals.remove exactly inverts add", () => {
  const reducer = new AddTaskTotals();
  const accum = { totalTasks: 4, openTasks: 2, openEffort: 9 };
  const value = { totalTasks: 1, openTasks: 1, openEffort: 5 };

  // Skip maintains reduced collections incrementally: if remove is not the
  // exact inverse of add, per-project totals drift as tasks change and never
  // recover.
  assert.deepEqual(reducer.remove(reducer.add(accum, value), value), accum);
});

test("AddTaskTotals.add treats a null accumulator as empty", () => {
  const reducer = new AddTaskTotals();
  const value = { totalTasks: 1, openTasks: 1, openEffort: 3 };

  assert.deepEqual(reducer.add(null, value), value);
  assert.deepEqual(reducer.initial, emptyTotals);
});

test("AddTaskTotals round-trips a whole project's tasks back to empty", () => {
  const reducer = new AddTaskTotals();
  const values = [
    { totalTasks: 1, openTasks: 1, openEffort: 3 },
    { totalTasks: 1, openTasks: 0, openEffort: 0 },
    { totalTasks: 1, openTasks: 1, openEffort: 8 },
  ];

  let accum: TaskTotals = emptyTotals;
  for (const value of values) accum = reducer.add(accum, value);
  for (const value of values) accum = reducer.remove(accum, value);

  assert.deepEqual(accum, emptyTotals);
});

test("TasksByProject counts a done task as closed effort", () => {
  const mapper = new TasksByProject();

  assert.deepEqual(
    [...mapper.mapEntry("task:1", only(task("done", 5)))],
    [["p1", { totalTasks: 1, openTasks: 0, openEffort: 0 }]],
  );
});

test("TasksByProject counts todo and doing tasks as open effort", () => {
  const mapper = new TasksByProject();

  for (const status of ["todo", "doing"] as const) {
    assert.deepEqual(
      [...mapper.mapEntry("task:1", only(task(status, 5)))],
      [["p1", { totalTasks: 1, openTasks: 1, openEffort: 5 }]],
      `status ${status} should count as open`,
    );
  }
});
