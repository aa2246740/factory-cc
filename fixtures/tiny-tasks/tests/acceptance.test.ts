import { beforeEach, describe, expect, it } from "vitest";
import { addTask, counts, deleteTask, editTask, toggleTask, visibleTasks, type Task } from "../src/store";

function seed(): Task[] {
  let tasks: Task[] = [];
  tasks = addTask(tasks, "买牛奶").tasks;
  tasks = addTask(tasks, "检查报告").tasks;
  return toggleTask(tasks, tasks[0]!.id);
}

describe("Tiny Tasks acceptance", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("creates 买牛奶 and 检查报告, then completes one", () => {
    const tasks = seed();
    expect(tasks.map((t) => t.title)).toEqual(["买牛奶", "检查报告"]);
    expect(tasks.filter((t) => t.completed)).toHaveLength(1);
  });

  it("filters and counts all / active / completed", () => {
    const tasks = seed();
    expect(counts(tasks)).toEqual({ all: 2, active: 1, completed: 1 });
    expect(visibleTasks(tasks, "all")).toHaveLength(2);
    expect(visibleTasks(tasks, "active").map((t) => t.title)).toEqual(["检查报告"]);
    expect(visibleTasks(tasks, "completed").map((t) => t.title)).toEqual(["买牛奶"]);
  });

  it("edits a Chinese title without changing completion", () => {
    const tasks = seed();
    const done = tasks.find((t) => t.completed)!;
    const next = editTask(tasks, done.id, "买豆浆").tasks;
    const edited = next.find((t) => t.id === done.id)!;
    expect(edited.title).toBe("买豆浆");
    expect(edited.completed).toBe(true);
  });

  it("persists titles and completion across reload", () => {
    const tasks = seed();
    localStorage.setItem("tiny-tasks.v1", JSON.stringify(tasks));
    const reloaded = JSON.parse(localStorage.getItem("tiny-tasks.v1")!) as Task[];
    expect(reloaded).toEqual(tasks);
  });

  it("deletes a completed task and restores the empty completed view", () => {
    let tasks = seed();
    const done = tasks.find((t) => t.completed)!;
    tasks = deleteTask(tasks, done.id);
    expect(counts(tasks)).toEqual({ all: 1, active: 1, completed: 0 });
    expect(visibleTasks(tasks, "completed")).toHaveLength(0);
  });

  it("rejects whitespace-only names", () => {
    const created = addTask([], "   ");
    expect(created.error).toBe("empty");
    expect(created.tasks).toHaveLength(0);
    const existing = seed();
    const edited = editTask(existing, existing[0]!.id, " \t");
    expect(edited.error).toBe("empty");
  });
});
