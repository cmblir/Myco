import { useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import type { TaskItem } from "../lib/ipc";
import { parseTaskMeta, today, type TaskStatus } from "../lib/taskLine";

/// The four columns, in the order work moves through them. `TaskStatus` is the
/// checkbox mark itself, so a column IS the mark written to the file — there is
/// no board state to keep in sync with the notes.
const COLUMNS: { status: TaskStatus; labelKey: keyof Strings; fallback: string }[] = [
  { status: "todo", labelKey: "tasks_col_todo", fallback: "To do" },
  { status: "doing", labelKey: "tasks_col_doing", fallback: "In progress" },
  { status: "blocked", labelKey: "tasks_col_blocked", fallback: "Blocked" },
  { status: "done", labelKey: "tasks_col_done", fallback: "Done" },
];

/// Kanban over the same scanned tasks. Drag is the platform's own HTML5 drag —
/// a card carries `page:line`, which is all a drop needs to rewrite one line.
export default function TaskBoard({
  t,
  tasks,
  statusOf,
  busy,
  onMove,
  onOpen,
}: {
  t: Strings;
  tasks: TaskItem[];
  statusOf: (task: TaskItem) => TaskStatus;
  busy: boolean;
  onMove: (task: TaskItem, status: TaskStatus) => void;
  onOpen: (task: TaskItem) => void;
}): JSX.Element {
  const [over, setOver] = useState<TaskStatus | null>(null);
  const byId = new Map(tasks.map((x) => [`${x.page}:${x.line}`, x]));

  const drop = (status: TaskStatus) => (e: React.DragEvent): void => {
    e.preventDefault();
    setOver(null);
    const task = byId.get(e.dataTransfer.getData("text/plain"));
    // Dropping a card back where it started is a no-op, not a rewrite.
    if (task && statusOf(task) !== status) onMove(task, status);
  };

  return (
    <div className="task-board" data-testid="task-board">
      {COLUMNS.map((col) => {
        const items = tasks.filter((x) => statusOf(x) === col.status);
        return (
          <section
            key={col.status}
            className={`task-col${over === col.status ? " is-over" : ""}`}
            data-testid={`col-${col.status}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(col.status);
            }}
            onDragLeave={() => setOver((s) => (s === col.status ? null : s))}
            onDrop={drop(col.status)}
          >
            <header className="task-col-head">
              <span>{(t[col.labelKey] as string | undefined) ?? col.fallback}</span>
              <span className="muted">{items.length}</span>
            </header>
            {items.map((task) => {
              const meta = parseTaskMeta(task.text);
              return (
                <article
                  key={`${task.page}:${task.line}`}
                  className="task-card"
                  draggable={!busy}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", `${task.page}:${task.line}`);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onOpen(task)}
                  title={`${task.page}:${task.line}`}
                >
                  <div className="task-card-title">{meta.title}</div>
                  <div className="task-card-meta">
                    {meta.due ? (
                      <span
                        className="chip"
                        style={{
                          color:
                            col.status !== "done" && meta.due < today()
                              ? "#dc2626"
                              : "var(--ink-3)",
                        }}
                      >
                        {meta.due.replace("T", " ")}
                      </span>
                    ) : null}
                    {meta.priority ? <span className="chip">p{meta.priority}</span> : null}
                    {/* The note a task lives in IS its project — no extra syntax. */}
                    <span className="chip task-card-page">{task.stem}</span>
                  </div>
                </article>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
