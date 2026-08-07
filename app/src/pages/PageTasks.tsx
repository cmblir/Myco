// Tasks — every markdown checkbox item across the vault in one place, plus the
// two writes that make the list usable on its own: adding a task, and checking
// one off. Both edit the markdown directly (see taskLine.ts), so a task written
// here is the same `- [ ] …` line you would have typed in the note. Scanning
// stays in Rust (tasks.rs); new tasks land in today's daily note, which is what
// makes the page work like a calendar you can write into.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { TaskItem } from "../lib/ipc";
import { isComposingKey } from "../lib/ime";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import {
  appendTaskLine,
  buildTaskLine,
  parseTaskMeta,
  setLineStatus,
  today,
} from "../lib/taskLine";

export default function PageTasks({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const setRoute = useUIStore((s) => s.setRoute);
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!currentVault) return;
    setLoading(true);
    setError(null);
    try {
      setTasks(await ipc.scanTasks(currentVault.path));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [currentVault]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /// Append a task to TODAY's daily note — the calendar-shaped home for "things
  /// I have to do", and a file that already exists in most vaults. The note is
  /// created on first use rather than requiring the user to make it.
  async function addTask(): Promise<void> {
    const text = draft.trim();
    if (!text || !currentVault || busy) return;
    setBusy(true);
    setError(null);
    const day = today();
    const dir = `${currentVault.path}/daily`;
    const path = `${dir}/${day}.md`;
    try {
      let content = "";
      try {
        content = (await ipc.readFile(path)).raw;
      } catch {
        // No note for today yet: create it seeded with its date heading.
        await ipc.createFolder(currentVault.path, "daily").catch(() => undefined);
        await ipc.createFile(dir, `${day}.md`).catch(() => undefined);
        content = `# ${day}\n\n`;
      }
      await ipc.writeFile(path, appendTaskLine(content, buildTaskLine(text, due)));
      setDraft("");
      setDue("");
      await refresh();
      void useVaultStore.getState().refreshTree();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /// Check a task off (or back on) by rewriting just its line.
  async function toggle(task: TaskItem): Promise<void> {
    if (!currentVault || busy) return;
    setBusy(true);
    setError(null);
    const path = `${currentVault.path}/${task.page}`;
    try {
      const { raw } = await ipc.readFile(path);
      const next = setLineStatus(raw, task.line, task.done ? "todo" : "done");
      if (next === null) {
        // The note changed since the scan, so this line number no longer points
        // at that checkbox. Rescan instead of editing whatever is there now.
        await refresh();
        setError(t.tasks_stale ?? "That note changed — the list has been refreshed.");
        return;
      }
      await ipc.writeFile(path, next);
      await refresh();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

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

      <div className="card" style={{ padding: 12, marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="input"
          style={{ border: "none", padding: "4px 0", boxShadow: "none", flex: 1 }}
          placeholder={t.tasks_ph ?? "What do you have to do?"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (isComposingKey(e)) return;
            if (e.key === "Enter") void addTask();
          }}
          disabled={busy || !currentVault}
          data-testid="task-input"
        />
        {/* Native date input: the platform already ships a picker, a calendar
            popover and locale formatting. */}
        <input
          className="input"
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          disabled={busy || !currentVault}
          style={{ width: 150 }}
          aria-label={t.tasks_due ?? "Due date"}
        />
        <button
          className="btn btn-primary"
          onClick={() => void addTask()}
          disabled={busy || !currentVault || !draft.trim()}
        >
          {t.tasks_add ?? "Add"}
        </button>
      </div>

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
                    onToggle={() => void toggle(task)}
                    busy={busy}
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
                    onToggle={() => void toggle(task)}
                    busy={busy}
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
  onToggle,
  busy,
}: {
  task: TaskItem;
  onOpen: () => void;
  onToggle: () => void;
  busy: boolean;
}): JSX.Element {
  const meta = parseTaskMeta(task.text);
  return (
    // A row, not a button: the checkbox has to be clickable on its own, and a
    // button inside a button is invalid HTML (and unreachable by keyboard).
    <div
      className="list-row"
      style={{
        gridTemplateColumns: "18px 1fr auto",
        gap: 10,
        alignItems: "center",
        width: "100%",
      }}
      title={`${task.page}:${task.line}`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={task.done}
        aria-label={task.text}
        disabled={busy}
        onClick={onToggle}
        style={{
          padding: 0,
          cursor: busy ? "default" : "pointer",
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
      </button>
      {/* The title opens the note the task lives in — that is still where you
          edit its wording. */}
      <button
        type="button"
        onClick={onOpen}
        style={{
          minWidth: 0,
          background: "transparent",
          border: 0,
          padding: 0,
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          overflow: "hidden",
        }}
      >
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
          {meta.title}
        </span>
        {meta.due ? (
          <span
            className="chip"
            style={{
              fontSize: 11,
              flexShrink: 0,
              // Overdue reads red; everything else stays quiet.
              color: !task.done && meta.due < today() ? "#dc2626" : "var(--ink-3)",
            }}
          >
            {meta.due.replace("T", " ")}
          </span>
        ) : null}
        {meta.priority ? (
          <span className="chip" style={{ fontSize: 11, flexShrink: 0 }}>
            p{meta.priority}
          </span>
        ) : null}
      </button>
      <span
        className="muted"
        style={{ fontSize: 12, flexShrink: 0, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {task.stem}
      </span>
    </div>
  );
}
