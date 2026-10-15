import {
  addTask,
  counts as honestCounts,
  deleteTask,
  editTask,
  loadTasks,
  normalizeTitle,
  saveTasks,
  toggleTask,
  type Filter,
  type Task,
} from "../../tiny-tasks/src/store";

export { addTask, deleteTask, editTask, loadTasks, normalizeTitle, saveTasks, toggleTask };
export type { Filter, Task };

/** Seeded defect: completed filter incorrectly includes active tasks. */
export function visibleTasks(tasks: Task[], filter: Filter): Task[] {
  if (filter === "active") return tasks.filter((task) => !task.completed);
  if (filter === "completed") return tasks;
  return tasks;
}

export function counts(tasks: Task[]): Record<Filter, number> {
  return { ...honestCounts(tasks), completed: tasks.length };
}
