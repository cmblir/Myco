import { useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import type { TaskItem } from "../lib/ipc";
import { usePointerDrag } from "../lib/pointerDrag";
import { parseTaskMeta, today, type TaskStatus } from "../lib/taskLine";
import { extractLinks, extractTags, stripTokens } from "../lib/taskTokens";
import { STATUSES } from "./TaskDetail";
import { Sheet, useSheetMode } from "./ui";

function statusLabel(t: Strings, status: TaskStatus): string {
  const s = STATUSES.find((x) => x.status === status) ?? STATUSES[0];
  return (t[s.labelKey] as string | undefined) ?? s.fallback;
}

/** The status chip's accessible name: "Status: To do". */
export function statusChipName(t: Strings, status: TaskStatus): string {
  return `${t.tasks_detail_status ?? "Status"}: ${statusLabel(t, status)}`;
}

/// Kanban over the same scanned tasks. Drag is pointer-based (see pointerDrag.ts
/// for why not HTML5) — a card carries `page:line`, which is all a drop needs to
/// rewrite one line. On a phone or a touch screen each card also has a status
/// chip that opens a sheet of the four statuses (UX S52): the way to move a
/// card without dragging, and the first way for a finger, which drags only
/// after a hold.
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
  const sheetMode = useSheetMode();
  const [picking, setPicking] = useState<TaskItem | null>(null);

  return (
    <div className="task-board" data-testid="task-board">
      {/* The columns are the detail's statuses. `TaskStatus` is the checkbox
          mark itself, so a column IS the mark written to the file — there is
          no board state to keep in sync with the notes. */}
      {STATUSES.map((col) => {
        const items = tasks.filter((x) => statusOf(x) === col.status);
        return (
          <section
            key={col.status}
            className={`task-col${over === col.status ? " is-over" : ""}`}
            data-testid={`col-${col.status}`}
            data-drop={col.status}
          >
            <header className="task-col-head">
              <span>{statusLabel(t, col.status)}</span>
              <span className="muted">{items.length}</span>
            </header>
            {items.map((task) => {
              const meta = parseTaskMeta(task.text);
              const tags = extractTags(meta.title);
              const links = extractLinks(meta.title);
              const id = `${task.page}:${task.line}`;
              const card = (
                <button
                  type="button"
                  key={id}
                  className={`task-card${drag.live?.id === id ? " is-dragging" : ""}${
                    drag.held === id ? " is-held" : ""
                  }`}
                  onPointerDown={drag.start(id)}
                  onClick={() => {
                    if (!drag.consumeClick()) onOpen(task);
                  }}
                  title={`${task.page}:${task.line}`}
                >
                  <span className="task-card-title">
                    {stripTokens(meta.title) || meta.title}
                  </span>
                  <span className="task-card-meta">
                    {meta.due ? (
                      <span
                        className="chip"
                        style={{
                          color:
                            col.status !== "done" && meta.due < today()
                              ? "var(--danger)"
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
                  </span>
                </button>
              );
              if (!sheetMode) return card;
              return (
                <div key={id} className="task-card-wrap">
                  {card}
                  <button
                    type="button"
                    className="pill task-status-chip"
                    disabled={busy}
                    aria-label={statusChipName(t, col.status)}
                    aria-haspopup="dialog"
                    onClick={() => setPicking(task)}
                  >
                    {statusLabel(t, col.status)}
                    <Icon name="chevD" size={12} />
                  </button>
                </div>
              );
            })}
          </section>
        );
      })}
      {picking ? (
        <Sheet
          title={stripTokens(parseTaskMeta(picking.text).title) || picking.text}
          meta={t.tasks_detail_status ?? "Status"}
          closeLabel={t.ui_close}
          onClose={() => setPicking(null)}
        >
          <ul className="myco-menu" role="group" aria-label={t.tasks_detail_status ?? "Status"}>
            {STATUSES.map((s) => {
              const current = statusOf(picking) === s.status;
              return (
                <li key={s.status}>
                  <button
                    type="button"
                    aria-pressed={current}
                    disabled={busy}
                    onClick={() => {
                      setPicking(null);
                      if (!current) onMove(picking, s.status);
                    }}
                  >
                    <span className="task-status-check" aria-hidden="true">
                      {current ? <Icon name="check" size={14} /> : null}
                    </span>
                    {statusLabel(t, s.status)}
                  </button>
                </li>
              );
            })}
          </ul>
        </Sheet>
      ) : null}
    </div>
  );
}
