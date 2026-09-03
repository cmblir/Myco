import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import type { TaskItem } from "../lib/ipc";
import { usePointerDrag } from "../lib/pointerDrag";
import { parseTaskMeta, today, type TaskStatus } from "../lib/taskLine";
import { extractLinks, extractTags, stripTokens } from "../lib/taskTokens";

/// The four columns, in the order work moves through them. `TaskStatus` is the
/// checkbox mark itself, so a column IS the mark written to the file — there is
/// no board state to keep in sync with the notes.
const COLUMNS: {
  status: TaskStatus;
  labelKey: keyof Strings;
  fallback: string;
}[] = [
  { status: "todo", labelKey: "tasks_col_todo", fallback: "To do" },
  { status: "doing", labelKey: "tasks_col_doing", fallback: "In progress" },
  { status: "blocked", labelKey: "tasks_col_blocked", fallback: "Blocked" },
  { status: "done", labelKey: "tasks_col_done", fallback: "Done" },
];

/// Kanban over the same scanned tasks. Drag is pointer-based (see pointerDrag.ts
/// for why not HTML5) — a card carries `page:line`, which is all a drop needs to
/// rewrite one line.
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
  const byId = new Map(tasks.map((x) => [`${x.page}:${x.line}`, x]));

  const drag = usePointerDrag((id, status) => {
    const task = byId.get(id);
    // Dropping a card back where it started is a no-op, not a rewrite.
    if (task && statusOf(task) !== status) onMove(task, status as TaskStatus);
  }, !busy);
  const over = drag.live?.target ?? null;

  return (
    <div className="task-board" data-testid="task-board">
      {COLUMNS.map((col) => {
        const items = tasks.filter((x) => statusOf(x) === col.status);
        return (
          <section
            key={col.status}
            className={`task-col${over === col.status ? " is-over" : ""}`}
            data-testid={`col-${col.status}`}
            data-drop={col.status}
          >
            <header className="task-col-head">
              <span>
                {(t[col.labelKey] as string | undefined) ?? col.fallback}
              </span>
              <span className="muted">{items.length}</span>
            </header>
            {items.map((task) => {
              const meta = parseTaskMeta(task.text);
              const tags = extractTags(meta.title);
              const links = extractLinks(meta.title);
              const id = `${task.page}:${task.line}`;
              return (
                <article
                  key={id}
                  className={`task-card${drag.live?.id === id ? " is-dragging" : ""}`}
                  onPointerDown={drag.start(id)}
                  onClick={() => {
                    if (!drag.consumeClick()) onOpen(task);
                  }}
                  title={`${task.page}:${task.line}`}
                >
                  <div className="task-card-title">
                    {stripTokens(meta.title) || meta.title}
                  </div>
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
                    {meta.priority ? (
                      <span className="chip">p{meta.priority}</span>
                    ) : null}
                    {tags.map((tag) => (
                      <span key={`#${tag}`} className="chip">
                        #{tag}
                      </span>
                    ))}
                    {links.map((link) => (
                      <span
                        key={`[[${link}`}
                        className="chip"
                        style={{ color: "var(--c-overview)" }}
                      >
                        {link}
                      </span>
                    ))}
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
