// Tasks — every markdown checkbox item across the vault in one place. Read-only:
// it lists open and done `- [ ]` / `- [x]` items and links each back to the note
// it lives in (where you edit it). Scanning happens in Rust (tasks.rs).

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { TaskItem } from "../lib/ipc";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

export default function PageTasks({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const setRoute = useUIStore((s) => s.setRoute);
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!currentVault) return;
    setLoading(true);
    setError(null);
    ipc
      .scanTasks(currentVault.path)
      .then(setTasks)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [currentVault]);

  const { open, done } = useMemo(() => {
    const all = tasks ?? [];
    return {
      open: all.filter((x) => !x.done),
      done: all.filter((x) => x.done),
    };
  }, [tasks]);

  const openPage = (task: TaskItem): void => {
    if (currentVault) setRoute(`page:${currentVault.path}/${task.page}`);
  };

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_tasks ?? "Tasks"}</div>
        <h1 className="page-title">{t.tasks_title ?? "Tasks"}</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          {t.tasks_lede ??
            "Every checkbox item across your notes, gathered in one place."}
        </p>
      </header>

      {loading ? (
        <div className="muted" style={{ padding: 12 }}>
          {t.tasks_loading ?? "Scanning notes…"}
        </div>
      ) : error ? (
        <div className="card" style={{ padding: 12, color: "#dc2626" }}>
          {error}
        </div>
      ) : (tasks?.length ?? 0) === 0 ? (
        <div className="card" style={{ padding: 16 }} data-testid="tasks-empty">
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            {t.tasks_empty ?? "No tasks yet"}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {t.tasks_empty_hint ??
              "Add a `- [ ] …` checkbox to any note and it will show up here."}
          </div>
        </div>
      ) : (
        <>
          <div
            className="row"
            style={{ gap: 8, marginBottom: 12, fontSize: 13 }}
          >
            <span className="chip" style={{ background: "var(--bg-soft)" }}>
              {(t.tasks_open_n ?? "{n} open").replace("{n}", String(open.length))}
            </span>
            <span className="chip" style={{ background: "var(--bg-soft)" }}>
              {(t.tasks_done_n ?? "{n} done").replace("{n}", String(done.length))}
            </span>
          </div>

          <section data-testid="tasks-open">
            {open.length === 0 ? (
              <div className="muted" style={{ fontSize: 13, padding: "4px 0 12px" }}>
                {t.tasks_all_done ?? "All caught up — nothing open."}
              </div>
            ) : (
              <div className="list">
                {open.map((task) => (
                  <TaskRow
                    key={`${task.page}:${task.line}`}
                    task={task}
                    onOpen={() => openPage(task)}
                  />
                ))}
              </div>
            )}
          </section>

          {done.length > 0 ? (
            <details style={{ marginTop: 14 }} data-testid="tasks-done">
              <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--ink-3)" }}>
                {(t.tasks_completed ?? "Completed ({n})").replace(
                  "{n}",
                  String(done.length),
                )}
              </summary>
              <div className="list" style={{ marginTop: 8, opacity: 0.7 }}>
                {done.map((task) => (
                  <TaskRow
                    key={`${task.page}:${task.line}`}
                    task={task}
                    onOpen={() => openPage(task)}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

function TaskRow({
  task,
  onOpen,
}: {
  task: TaskItem;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      className="list-row"
      style={{
        gridTemplateColumns: "18px 1fr auto",
        gap: 10,
        alignItems: "center",
        background: "transparent",
        border: 0,
        textAlign: "left",
        width: "100%",
      }}
      onClick={onOpen}
      title={`${task.page}:${task.line}`}
    >
      <span
        aria-hidden="true"
        style={{
          width: 15,
          height: 15,
          borderRadius: 3,
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          color: "#fff",
          border: `1.5px solid ${task.done ? "var(--c-entity)" : "var(--ink-3)"}`,
          background: task.done ? "var(--c-entity)" : "transparent",
        }}
      >
        {task.done ? <Icon name="check" size={10} /> : null}
      </span>
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textDecoration: task.done ? "line-through" : "none",
          color: task.done ? "var(--ink-3)" : "var(--ink)",
        }}
      >
        {task.text}
      </span>
      <span
        className="muted"
        style={{ fontSize: 12, flexShrink: 0, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {task.stem}
      </span>
    </button>
  );
}
