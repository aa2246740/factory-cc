export type Filter = "all" | "active" | "completed";

export interface Task {
  id: string;
  title: string;
  completed: boolean;
}

const KEY = "tiny-tasks.v1";

export function loadTasks(storage: Storage = localStorage): Task[] {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Task[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTasks(tasks: Task[], storage: Storage = localStorage): void {
  storage.setItem(KEY, JSON.stringify(tasks));
}

export function normalizeTitle(title: string): string | undefined {
  const trimmed = title.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function addTask(tasks: Task[], title: string): { tasks: Task[]; error?: string } {
  const normalized = normalizeTitle(title);
  if (!normalized) return { tasks, error: "empty" };
  return {
    tasks: [...tasks, { id: crypto.randomUUID(), title: normalized, completed: false }],
  };
}

export function editTask(tasks: Task[], id: string, title: string): { tasks: Task[]; error?: string } {
  const normalized = normalizeTitle(title);
  if (!normalized) return { tasks, error: "empty" };
  return {
    tasks: tasks.map((task) => (task.id === id ? { ...task, title: normalized } : task)),
  };
}

export function toggleTask(tasks: Task[], id: string): Task[] {
  return tasks.map((task) => (task.id === id ? { ...task, completed: !task.completed } : task));
}

export function deleteTask(tasks: Task[], id: string): Task[] {
  return tasks.filter((task) => task.id !== id);
}

export function visibleTasks(tasks: Task[], filter: Filter): Task[] {
  if (filter === "active") return tasks.filter((task) => !task.completed);
  if (filter === "completed") return tasks.filter((task) => task.completed);
  return tasks;
}

export function counts(tasks: Task[]): Record<Filter, number> {
  return {
    all: tasks.length,
    active: tasks.filter((task) => !task.completed).length,
    completed: tasks.filter((task) => task.completed).length,
  };
}
