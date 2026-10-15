import {
  addTask,
  counts,
  deleteTask,
  editTask,
  loadTasks,
  saveTasks,
  toggleTask,
  visibleTasks,
  type Filter,
  type Task,
} from "./store";

let tasks: Task[] = loadTasks();
let filter: Filter = "all";

const list = document.querySelector("#task-list")!;
const empty = document.querySelector("#empty")!;
const form = document.querySelector("#create-form") as HTMLFormElement;
const input = document.querySelector("#title-input") as HTMLInputElement;
const error = document.querySelector("#form-error") as HTMLElement;

function render(): void {
  saveTasks(tasks);
  const visible = visibleTasks(tasks, filter);
  list.innerHTML = "";
  for (const task of visible) {
    const li = document.createElement("li");
    li.dataset.id = task.id;
    li.className = task.completed ? "done" : "";
    li.innerHTML = `
      <label>
        <input type="checkbox" data-toggle="${task.id}" ${task.completed ? "checked" : ""} />
        <span class="title">${escapeHtml(task.title)}</span>
      </label>
      <button type="button" data-edit="${task.id}">编辑</button>
      <button type="button" data-delete="${task.id}">删除</button>
    `;
    list.append(li);
  }
  empty.hidden = visible.length > 0;
  empty.textContent = filter === "completed" && tasks.length > 0 ? "没有已完成的任务。" : "还没有任务。";
  const tally = counts(tasks);
  for (const key of Object.keys(tally) as Filter[]) {
    const node = document.querySelector(`[data-count="${key}"]`);
    if (node) node.textContent = String(tally[key]);
  }
  document.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-filter") === filter);
  });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const result = addTask(tasks, input.value);
  error.hidden = !result.error;
  if (result.error) return;
  tasks = result.tasks;
  input.value = "";
  render();
});

list.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const toggle = target.getAttribute("data-toggle") ?? target.closest("[data-toggle]")?.getAttribute("data-toggle");
  const del = target.getAttribute("data-delete");
  const edit = target.getAttribute("data-edit");
  if (toggle) {
    tasks = toggleTask(tasks, toggle);
    render();
  }
  if (del) {
    tasks = deleteTask(tasks, del);
    render();
  }
  if (edit) {
    const current = tasks.find((t) => t.id === edit);
    const next = prompt("新的任务名", current?.title ?? "");
    if (next === null) return;
    const result = editTask(tasks, edit, next);
    if (result.error) {
      error.hidden = false;
      return;
    }
    tasks = result.tasks;
    render();
  }
});

document.querySelector(".filters")!.addEventListener("click", (event) => {
  const next = (event.target as HTMLElement).closest("[data-filter]")?.getAttribute("data-filter");
  if (next === "all" || next === "active" || next === "completed") {
    filter = next;
    render();
  }
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

render();
