// The 로드맵 view — every `wiki/roadmaps/*.md` page as a card: title,
// aggregate progress, then each `## milestone` as a checklist. Items are the
// same scanned tasks every other view shows; checking one goes through the
// page's writer (✅ stamp, recurrence, stale guard) and clicking one opens the
// same detail panel.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { TaskItem } from "../lib/ipc";
import { parseTaskMeta } from "../lib/taskLine";
import { extractTags, stripTokens } from "../lib/taskTokens";
import { parseRoadmap, type Roadmap } from "../lib/roadmap";
import { useVaultStore } from "../stores/vaultStore";

function Progress({
  done,
  total,
  t,
}: {
  done: number;
  total: number;
  t: Strings;
}): JSX.Element {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <span className="row" style={{ gap: 8, alignItems: "center" }}>
      <span className="task-roadmap-bar" role="presentation">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>
        {(t.tasks_roadmap_progress ?? "{done}/{total} done")
          .replace("{done}", String(done))
          .replace("{total}", String(total))}
      </span>
    </span>
  );
}

export default function TaskRoadmap({
  t,
  tasks,
  pages,
  busy,
  onToggle,
  onOpen,
  onNewRoadmap,
}: {
  t: Strings;
  tasks: TaskItem[];
  /** `wiki/roadmaps/*` pages from the tree. */
  pages: { path: string; stem: string }[];
  busy: boolean;
  onToggle: (task: TaskItem) => void;
  onOpen: (task: TaskItem) => void;
  onNewRoadmap: () => void;
}): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault?.path ?? null);
  const [roadmaps, setRoadmaps] = useState<Roadmap[] | null>(null);

  // Re-read the few roadmap pages whenever the scan or the page list moves —
  // the raw text is needed for milestone headings, which the scanner drops.
  useEffect(() => {
    let alive = true;
    if (!currentVault || pages.length === 0) {
      setRoadmaps([]);
      return;
    }
    void (async () => {
      const out: Roadmap[] = [];
      for (const p of pages) {
        const raw = await ipc
          .readFile(`${currentVault}/${p.path}`)
          .then((f) => f.raw)
          .catch(() => null);
        if (raw === null) continue;
        out.push(
          parseRoadmap(
            p.path,
            p.stem,
            raw,
            tasks.filter((x) => x.page === p.path),
          ),
        );
      }
      if (alive) setRoadmaps(out);
    })();
    return () => {
      alive = false;
    };
  }, [currentVault, pages, tasks]);

  if (roadmaps === null) {
    return (
      <div className="muted" style={{ padding: 12 }}>
        {t.tasks_loading ?? "Scanning notes…"}
      </div>
    );
  }

  if (roadmaps.length === 0) {
    return (
      <div
        className="card"
        style={{ padding: 16, marginTop: 16 }}
        data-testid="roadmap-empty"
      >
        <div style={{ fontWeight: 500, marginBottom: 4 }}>
          {t.tasks_roadmap_empty ?? "No roadmaps yet"}
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
          {t.tasks_roadmap_empty_hint ??
            "A roadmap is a wiki page (wiki/roadmaps/…) of milestones and checkboxes."}
        </div>
        <button className="btn" onClick={onNewRoadmap} disabled={busy}>
          {t.tasks_new_roadmap ?? "＋ New roadmap…"}
        </button>
      </div>
    );
  }

  const byLine = new Map(tasks.map((x) => [`${x.page}:${x.line}`, x]));

  return (
    <div
      className="col"
      style={{ gap: 12, marginTop: 16 }}
      data-testid="task-roadmap"
    >
      {roadmaps.map((r) => (
        <section key={r.page} className="card" style={{ padding: 14 }}>
          <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
            <strong style={{ fontSize: 14.5 }}>{r.title}</strong>
            <span style={{ marginLeft: "auto", minWidth: 180 }}>
              <Progress done={r.done} total={r.total} t={t} />
            </span>
          </div>
          {r.milestones.map((m) => (
            <div key={`${r.page}#${m.heading}`} style={{ marginTop: 10 }}>
              {m.heading ? (
                <div
                  className="row"
                  style={{ gap: 8, alignItems: "baseline", marginBottom: 4 }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--ink-2)",
                    }}
                  >
                    {m.heading}
                  </span>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {m.done}/{m.total}
                  </span>
                </div>
              ) : null}
              {m.lines.map((line) => {
                const task = byLine.get(`${r.page}:${line}`);
                if (!task) return null;
                const meta = parseTaskMeta(task.text);
                const tags = extractTags(meta.title);
                return (
                  <div
                    key={line}
                    className="row"
                    style={{ gap: 8, alignItems: "center", padding: "2px 0" }}
                  >
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={task.done}
                      aria-label={task.text}
                      disabled={busy}
                      onClick={() => onToggle(task)}
                      style={{
                        padding: 0,
                        width: 14,
                        height: 14,
                        borderRadius: 3,
                        flexShrink: 0,
                        display: "grid",
                        placeItems: "center",
                        color: "#fff",
                        cursor: busy ? "default" : "pointer",
                        border: `1.5px solid ${task.done ? "var(--c-entity)" : "var(--ink-3)"}`,
                        background: task.done
                          ? "var(--c-entity)"
                          : "transparent",
                      }}
                    >
                      {task.done ? <Icon name="check" size={9} /> : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpen(task)}
                      style={{
                        background: "transparent",
                        border: 0,
                        padding: 0,
                        textAlign: "left",
                        cursor: "pointer",
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 13,
                        textDecoration: task.done ? "line-through" : "none",
                        color: task.done ? "var(--ink-3)" : "var(--ink)",
                      }}
                    >
                      {stripTokens(meta.title) || meta.title}
                    </button>
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="chip"
                        style={{ fontSize: 10.5, flexShrink: 0 }}
                      >
                        #{tag}
                      </span>
                    ))}
                    {meta.due ? (
                      <span
                        className="chip"
                        style={{
                          fontSize: 10.5,
                          flexShrink: 0,
                          color: "var(--ink-3)",
                        }}
                      >
                        {meta.due.slice(0, 10)}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      ))}
      <div>
        <button
          className="btn btn-ghost"
          onClick={onNewRoadmap}
          disabled={busy}
        >
          {t.tasks_new_roadmap ?? "＋ New roadmap…"}
        </button>
      </div>
    </div>
  );
}
