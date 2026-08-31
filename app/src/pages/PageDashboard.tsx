// Chart dashboard — a user-composed board of small charts over the data the
// app already holds: adjacency meta/tags (link scanner), file mtimes, and
// the task scan. Widgets add/remove/reorder/configure in place and persist
// to localStorage (lib/dashboard.ts), the same composition model as the
// Views page's saved lenses.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import { ipc } from "../lib/ipc";
import type { TaskItem } from "../lib/ipc";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { flattenMarkdown } from "../lib/graphData";
import { facetValues, wikiPagesOnly } from "../lib/queryViews";
import {
  computeStats,
  defaultWidgets,
  loadWidgets,
  newWidget,
  saveWidgets,
  taskStatusCounts,
  weeklyActivity,
  type DashDim,
  type DashKind,
  type DashWidget,
} from "../lib/dashboard";
import { HBars, StatTiles, TYPE_COLORS, WeekBars } from "../components/DashCharts";

const KINDS: DashKind[] = ["stats", "activity", "distribution", "tags", "tasks"];

function kindLabel(t: Strings, kind: DashKind): string {
  switch (kind) {
    case "stats":
      return t.db_w_stats ?? "At a glance";
    case "activity":
      return t.db_w_activity ?? "Weekly edits";
    case "distribution":
      return t.db_w_distribution ?? "Distribution";
    case "tags":
      return t.db_w_tags ?? "Top tags";
    case "tasks":
      return t.db_w_tasks ?? "Tasks by status";
  }
}

function dimLabel(t: Strings, dim: DashDim): string {
  switch (dim) {
    case "types":
      return t.vw_col_type ?? "Type";
    case "confidence":
      return t.vw_col_conf ?? "Confidence";
    case "status":
      return t.vw_col_status ?? "Status";
  }
}

export default function PageDashboard({ t }: { t: Strings }): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const fileTree = useVaultStore((s) => s.fileTree);
  const adjacency = useVaultStore((s) => s.adjacency);
  const vaultPath = useVaultStore((s) => s.currentVault?.path);

  const [widgets, setWidgets] = useState<DashWidget[]>(() => loadWidgets());
  const [addKind, setAddKind] = useState<DashKind>("distribution");
  const [mtimes, setMtimes] = useState<Map<string, number>>(new Map());
  const [tasks, setTasks] = useState<TaskItem[]>([]);

  // Same scoping as Views: every wiki-frontmatter chart reads wiki/ only,
  // but the activity chart deliberately reads the WHOLE vault — sessions and
  // daily notes are activity too.
  const files = useMemo(
    () => wikiPagesOnly(flattenMarkdown(fileTree), vaultPath),
    [fileTree, vaultPath],
  );
  const facets = useMemo(
    () => (adjacency ? facetValues(adjacency, files) : null),
    [adjacency, files],
  );

  useEffect(() => {
    if (!vaultPath) return;
    let cancelled = false;
    void ipc
      .fileMtimes(vaultPath)
      .then((pairs) => {
        if (!cancelled) setMtimes(new Map(pairs));
      })
      .catch(() => {
        if (!cancelled) setMtimes(new Map());
      });
    void ipc
      .scanTasks(vaultPath)
      .then((items) => {
        if (!cancelled) setTasks(items);
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  const update = (next: DashWidget[]): void => {
    setWidgets(next);
    saveWidgets(next);
  };
  const patch = (id: string, w: DashWidget): void =>
    update(widgets.map((x) => (x.id === id ? w : x)));
  const move = (id: string, dir: -1 | 1): void => {
    const i = widgets.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= widgets.length) return;
    const next = [...widgets];
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
  };

  const stats = useMemo(
    () =>
      adjacency
        ? computeStats(adjacency, files, tasks, mtimes, Date.now())
        : null,
    [adjacency, files, tasks, mtimes],
  );

  function body(w: DashWidget): JSX.Element | null {
    switch (w.kind) {
      case "stats":
        return stats ? (
          <StatTiles
            tiles={[
              { label: t.db_stat_pages ?? "Wiki pages", value: stats.pages },
              { label: t.db_stat_open ?? "Open tasks", value: stats.openTasks },
              {
                label: t.vw_lens_unsourced ?? "No sources",
                value: stats.unsourced,
              },
              {
                label: t.db_stat_week ?? "Edited this week",
                value: stats.editedThisWeek,
              },
            ]}
          />
        ) : null;
      case "activity":
        return (
          <WeekBars
            buckets={weeklyActivity(mtimes.values(), w.weeks, Date.now())}
            lang={lang}
          />
        );
      case "distribution": {
        const rows = (facets?.[w.dim] ?? []).map((f) => ({
          label: f.value,
          count: f.count,
          // Identity color only where one exists (types); confidence/status
          // are single-series magnitude and stay on the accent.
          color: w.dim === "types" ? TYPE_COLORS[f.value] : undefined,
        }));
        return rows.length > 0 ? (
          <HBars rows={rows} />
        ) : (
          <p className="muted">{t.db_empty ?? "Nothing to chart yet."}</p>
        );
      }
      case "tags": {
        const rows = (facets?.tags ?? []).slice(0, w.topN).map((f) => ({
          label: `#${f.value}`,
          count: f.count,
        }));
        return rows.length > 0 ? (
          <HBars rows={rows} />
        ) : (
          <p className="muted">{t.db_empty ?? "Nothing to chart yet."}</p>
        );
      }
      case "tasks": {
        const rows = taskStatusCounts(tasks).map((s) => ({
          label:
            s.status === "todo"
              ? (t.tasks_col_todo ?? "To do")
              : s.status === "doing"
                ? (t.tasks_col_doing ?? "In progress")
                : s.status === "blocked"
                  ? (t.tasks_col_blocked ?? "Blocked")
                  : (t.tasks_col_done ?? "Done"),
          count: s.count,
        }));
        return <HBars rows={rows} />;
      }
    }
  }

  /** Per-widget config controls, rendered inline in the card head. */
  function config(w: DashWidget): JSX.Element | null {
    switch (w.kind) {
      case "activity":
        return (
          <select
            className="input dash-config"
            value={w.weeks}
            aria-label={t.db_w_activity ?? "Weekly edits"}
            onChange={(e) =>
              patch(w.id, { ...w, weeks: Number(e.target.value) })
            }
          >
            {[8, 12, 26, 52].map((n) => (
              <option key={n} value={n}>
                {n}w
              </option>
            ))}
          </select>
        );
      case "distribution":
        return (
          <select
            className="input dash-config"
            value={w.dim}
            aria-label={t.db_w_distribution ?? "Distribution"}
            onChange={(e) =>
              patch(w.id, { ...w, dim: e.target.value as DashDim })
            }
          >
            {(["types", "confidence", "status"] as const).map((d) => (
              <option key={d} value={d}>
                {dimLabel(t, d)}
              </option>
            ))}
          </select>
        );
      case "tags":
        return (
          <select
            className="input dash-config"
            value={w.topN}
            aria-label={t.db_w_tags ?? "Top tags"}
            onChange={(e) => patch(w.id, { ...w, topN: Number(e.target.value) })}
          >
            {[5, 8, 12, 20].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        );
      default:
        return null;
    }
  }

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_dashboard ?? "Dashboard"}</div>
        <h1 className="page-title">{t.db_title ?? "Chart dashboard"}</h1>
        <p className="page-lede">
          {t.db_lede ??
            "Your vault as charts — compose the board from the widgets below; it remembers your arrangement."}
        </p>
      </header>

      <div className="dash-toolbar">
        <select
          className="input"
          value={addKind}
          aria-label={t.db_add ?? "Add widget"}
          onChange={(e) => setAddKind(e.target.value as DashKind)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(t, k)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          onClick={() => update([...widgets, newWidget(addKind, widgets)])}
        >
          <Icon name="plus" size={13} /> {t.db_add ?? "Add widget"}
        </button>
        {widgets.length === 0 ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => update(defaultWidgets())}
          >
            {t.db_reset ?? "Restore defaults"}
          </button>
        ) : null}
      </div>

      <div className="dash-grid">
        {widgets.map((w, i) => (
          <section className="dash-card" key={w.id} aria-label={kindLabel(t, w.kind)}>
            <header className="dash-card__head">
              <b>{kindLabel(t, w.kind)}</b>
              {config(w)}
              <span className="dash-card__spacer" />
              <button
                type="button"
                className="btn-ghost btn dash-card__btn"
                aria-label="↑"
                disabled={i === 0}
                onClick={() => move(w.id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn-ghost btn dash-card__btn"
                aria-label="↓"
                disabled={i === widgets.length - 1}
                onClick={() => move(w.id, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn-ghost btn dash-card__btn"
                aria-label={t.ui_close ?? "Remove"}
                onClick={() => update(widgets.filter((x) => x.id !== w.id))}
              >
                <Icon name="x" size={11} />
              </button>
            </header>
            {body(w)}
          </section>
        ))}
      </div>
    </div>
  );
}
