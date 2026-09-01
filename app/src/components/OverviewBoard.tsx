// "내 보드" — the customizable chart board on the Overview page. Freedom
// comes from the three researched layers (lib/board.ts): a 12-column
// coordinate grid (react-grid-layout: drag by the grip, resize at the corner,
// collisions push), widgets that are QUESTIONS assembled in a mini builder,
// and one global time range every "auto" widget follows. View mode locks the
// grid (accidental drags are the #1 customization killer); Edit mode shows
// the handles and the builder. The whole board persists as one JSON document
// in the vault.

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import {
  GridLayout,
  noCompactor,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { Icon } from "../lib/icons";
import { ipc } from "../lib/ipc";
import type { TaskItem, InflowDay } from "../lib/ipc";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { flattenMarkdown } from "../lib/graphData";
import { facetValues, wikiPagesOnly } from "../lib/queryViews";
import Viewer from "./Viewer";
import {
  aliasLabel,
  appendWidget,
  BOARD_COLS,
  BOARD_PRESETS,
  BOARD_ROW_PX,
  CHANNELS,
  DEFAULT_BOARD,
  duplicateWidget,
  effectiveRange,
  emptyBoard,
  freshId,
  loadBoard,
  minSize,
  removeWidget,
  ruleColor,
  runBoardQuery,
  saveBoard,
  statValue,
  type BoardData,
  type BoardDoc,
  type BoardRange,
  type BoardSource,
  type BoardView,
  type BoardWidget,
} from "../lib/board";
import { CatTable, DayBars, DayLine, HBars, TYPE_COLORS } from "./DashCharts";

const RANGES: BoardRange[] = ["7d", "30d", "90d", "all"];

function rangeLabel(t: Strings, r: BoardRange): string {
  return r === "all" ? (t.bd_range_all ?? "All") : r;
}

function presetLabel(t: Strings, key: string): string {
  const k = `bd_preset_${key.replace(/-/g, "_")}` as keyof Strings;
  return (t[k] as string | undefined) ?? key;
}

function sourceLabel(t: Strings, s: BoardSource): string {
  return s === "inflow"
    ? (t.bd_src_inflow ?? "Inflow")
    : s === "tasks"
      ? (t.bd_src_tasks ?? "Tasks")
      : (t.bd_src_notes ?? "Notes");
}

function groupLabel(t: Strings, g: string): string {
  const k = `bd_g_${g}` as keyof Strings;
  return (t[k] as string | undefined) ?? g;
}

function viewLabel(t: Strings, v: BoardView): string {
  const k = `bd_v_${v}` as keyof Strings;
  return (t[k] as string | undefined) ?? v;
}

/** Generated fallback title, in the UI language — "유입 · 일별 · mcp", not
 *  raw English tokens beside Korean chrome. */
function autoTitle(t: Strings, w: BoardWidget): string {
  if (w.kind !== "query" || !w.query) return "";
  const f = w.query.filters.map((x) => x.value).join(" ");
  return [sourceLabel(t, w.query.source), groupLabel(t, w.query.groupBy), f]
    .filter(Boolean)
    .join(" · ");
}

export default function OverviewBoard({ t }: { t: Strings }): JSX.Element | null {
  const lang = useUIStore((s) => s.lang);
  const vaultPath = useVaultStore((s) => s.currentVault?.path);
  const adjacency = useVaultStore((s) => s.adjacency);
  const fileTree = useVaultStore((s) => s.fileTree);

  const [doc, setDoc] = useState<BoardDoc>(() => emptyBoard());
  const [loaded, setLoaded] = useState(false);
  // Which board file is open. Boards are files (.myco/dashboards/*.json);
  // the listing IS the list, and the active pick survives restarts.
  const [boardName, setBoardName] = useState<string>(() => {
    try {
      return localStorage.getItem("myco.board.active") ?? DEFAULT_BOARD;
    } catch {
      return DEFAULT_BOARD;
    }
  });
  const [boards, setBoards] = useState<string[]>([DEFAULT_BOARD]);
  const refreshBoards = (): void => {
    void ipc
      .listDashboards()
      .then((names) => {
        const all = [...new Set([DEFAULT_BOARD, ...names])];
        setBoards(all);
      })
      .catch(() => setBoards([DEFAULT_BOARD]));
  };
  const switchBoard = (name: string): void => {
    setBoardName(name);
    setEditing(null);
    try {
      localStorage.setItem("myco.board.active", name);
    } catch {
      /* localStorage unavailable */
    }
  };
  const [edit, setEdit] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [addPick, setAddPick] = useState<string>(BOARD_PRESETS[0].key);
  /** Widget opened in the detail modal (view-mode click) — full-size chart
   *  plus the numbers behind it. */
  const [detailId, setDetailId] = useState<string | null>(null);

  // --- data the queries read ------------------------------------------------
  const files = useMemo(
    () => wikiPagesOnly(flattenMarkdown(fileTree), vaultPath),
    [fileTree, vaultPath],
  );
  const facets = useMemo(
    () => (adjacency ? facetValues(adjacency, files) : null),
    [adjacency, files],
  );
  const [mtimes, setMtimes] = useState<Map<string, number>>(new Map());
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [inflow, setInflow] = useState<InflowDay[]>([]);
  useEffect(() => {
    if (!vaultPath) return;
    let gone = false;
    void ipc.fileMtimes(vaultPath).then((p) => {
      if (!gone) setMtimes(new Map(p));
    }).catch(() => undefined);
    void ipc.scanTasks(vaultPath).then((x) => {
      if (!gone) setTasks(x);
    }).catch(() => undefined);
    void ipc.inflowDaily(365).then((x) => {
      if (!gone) setInflow(x);
    }).catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [vaultPath]);

  const data: BoardData = useMemo(
    () => ({ adjacency, files, mtimes, tasks, inflow }),
    [adjacency, files, mtimes, tasks, inflow],
  );

  // --- board load/save --------------------------------------------------------
  useEffect(() => {
    if (!vaultPath) return;
    let gone = false;
    setLoaded(false);
    refreshBoards();
    void loadBoard(vaultPath, boardName).then((d) => {
      if (!gone) {
        setDoc(d);
        setLoaded(true);
      }
    });
    return () => {
      gone = true;
    };
  }, [vaultPath, boardName]);

  // Debounced persist — a drag emits many layout changes; the file gets one.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = (next: BoardDoc): void => {
    setDoc(next);
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveBoard(boardName, next).catch(() => undefined);
    }, 400);
  };

  const { width, containerRef, mounted } = useContainerWidth();

  if (!vaultPath) return null;

  // Visibility conditions (HA-style): in view mode a zero-total widget
  // disappears AND frees its grid space (the compactor reflows around it);
  // edit mode always shows everything so the condition can be changed.
  const hiddenIds = new Set(
    edit
      ? []
      : doc.widgets
          .filter(
            (w) =>
              w.kind === "query" &&
              w.query &&
              w.hideWhenZero &&
              statValue(
                runBoardQuery(data, w.query, effectiveRange(w, doc.range), Date.now()),
              ) === 0,
          )
          .map((w) => w.id),
  );
  const visibleWidgets = doc.widgets.filter((w) => !hiddenIds.has(w.id));

  const layout = doc.layout
    .filter((l) => !hiddenIds.has(l.i))
    .map((l) => {
      const w = doc.widgets.find((x) => x.id === l.i);
      return w ? { ...l, ...minSize(w) } : l;
    });

  const addWidget = (): void => {
    let widget: BoardWidget;
    if (addPick === "text") {
      widget = { id: freshId(doc, "text"), kind: "text", text: "" };
    } else if (addPick === "heading") {
      widget = { id: freshId(doc, "h"), kind: "heading", text: "" };
    } else if (addPick === "custom") {
      widget = {
        id: freshId(doc, "q"),
        kind: "query",
        query: { source: "notes", groupBy: "type", filters: [] },
        view: "hbar",
        time: "auto",
      };
    } else {
      const p = BOARD_PRESETS.find((x) => x.key === addPick);
      if (!p) return;
      widget = {
        ...(JSON.parse(JSON.stringify(p.widget)) as Omit<BoardWidget, "id">),
        id: freshId(doc, addPick),
      };
    }
    update(appendWidget(doc, widget));
    if (widget.kind !== "query" || addPick === "custom") setEditing(widget.id);
  };

  function widgetBody(w: BoardWidget): JSX.Element | null {
    // A board file written by a newer version (or hand-edited) may carry a
    // kind this build doesn't know. Render a config-preserving notice, never
    // drop it — the data outlives the app version (HA's red-card rule).
    if (w.kind !== "query" && w.kind !== "text" && w.kind !== "heading") {
      return (
        <p className="muted bw-empty">
          {(t.bd_unknown ?? "Unknown widget type “{kind}” — kept as saved.").replace(
            "{kind}",
            String(w.kind),
          )}
        </p>
      );
    }
    if (w.kind === "heading") {
      return <div className="bw-heading">{w.text || "—"}</div>;
    }
    if (w.kind === "text") {
      return (
        <div className="bw-text">
          <Viewer content={w.text ?? ""} onLinkClick={() => undefined} />
        </div>
      );
    }
    if (!w.query) return null;
    const r = runBoardQuery(data, w.query, effectiveRange(w, doc.range), Date.now());
    const view = w.view ?? "hbar";
    if (view === "stat") {
      const v = statValue(r);
      const c = ruleColor(w.colorRules, v);
      return (
        <div className="bw-stat" data-tone={c ?? undefined}>
          <span className="bw-stat__num">{v}</span>
        </div>
      );
    }
    if (r.kind === "series") {
      if (view === "line") return <DayLine days={r.days} lang={lang} color={w.color} />;
      if (view === "table")
        return (
          <CatTable rows={r.days.filter((d) => d.total > 0).map((d) => ({ label: d.day, value: d.total })).reverse()} />
        );
      return <DayBars days={r.days} lang={lang} color={w.color} />;
    }
    if (r.rows.length === 0) {
      return <p className="muted bw-empty">{t.db_empty ?? "Nothing to chart yet."}</p>;
    }
    if (view === "table")
      return (
        <CatTable
          rows={r.rows.map((x) => ({ label: aliasLabel(w, x.label), value: x.value }))}
        />
      );
    return (
      <HBars
        rows={r.rows.map((x) => ({
          label: aliasLabel(w, w.query?.groupBy === "tag" ? `#${x.label}` : x.label),
          count: x.value,
          // Identity colors (type) win over the widget's custom color —
          // color follows the entity. A 7th category (map, custom types)
          // folds to a muted neutral per the palette rule, never the accent.
          color:
            w.query?.groupBy === "type"
              ? (TYPE_COLORS[x.label] ?? "var(--ink-3)")
              : w.color,
        }))}
      />
    );
  }

  return (
    <section className="board" aria-label={t.bd_title ?? "My board"}>
      <div className="board-head">
        <h2 className="board-title">{t.bd_title ?? "My board"}</h2>
        {boards.length > 1 || edit ? (
          <select
            className="input board-add"
            value={boardName}
            aria-label={t.bd_board_pick ?? "Board"}
            onChange={(e) => switchBoard(e.target.value)}
          >
            {boards.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        ) : null}
        <div className="segmented board-range" role="group" aria-label={t.bd_range ?? "Range"}>
          {RANGES.map((r) => (
            <button
              key={r}
              className={doc.range === r ? "active" : ""}
              aria-pressed={doc.range === r}
              onClick={() => update({ ...doc, range: r })}
            >
              {rangeLabel(t, r)}
            </button>
          ))}
        </div>
        <span className="board-spacer" />
        {edit ? (
          <>
            <select
              className="input board-add"
              value={addPick}
              aria-label={t.bd_add ?? "Add widget"}
              onChange={(e) => setAddPick(e.target.value)}
            >
              {BOARD_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {presetLabel(t, p.key)}
                </option>
              ))}
              <option value="custom">{t.bd_custom ?? "Custom question…"}</option>
              <option value="text">{t.bd_text ?? "Text (markdown)"}</option>
              <option value="heading">{t.bd_heading ?? "Heading"}</option>
            </select>
            <button className="btn" onClick={addWidget}>
              <Icon name="plus" size={12} /> {t.bd_add ?? "Add widget"}
            </button>
            <select
              className="input board-add"
              value={doc.compact}
              aria-label={t.bd_compact ?? "Compaction"}
              onChange={(e) =>
                update({ ...doc, compact: e.target.value as BoardDoc["compact"] })
              }
            >
              <option value="vertical">{t.bd_compact_v ?? "Pack upward"}</option>
              <option value="none">{t.bd_compact_none ?? "Keep whitespace"}</option>
            </select>
            <button
              className="btn"
              onClick={() => {
                const name = window
                  .prompt(t.bd_new_board_prompt ?? "Board name:")
                  ?.trim();
                if (!name) return;
                if (name.includes("/") || name.includes("\\") || name.includes("..")) return;
                void saveBoard(name, emptyBoard())
                  .then(() => {
                    refreshBoards();
                    switchBoard(name);
                  })
                  .catch(() => undefined);
              }}
            >
              {t.bd_new_board ?? "New board"}
            </button>
            {boardName !== DEFAULT_BOARD ? (
              <button
                className="btn"
                onClick={() => {
                  const msg = (t.bd_delete_confirm ?? "Delete board “{name}”?").replace(
                    "{name}",
                    boardName,
                  );
                  if (!window.confirm(msg)) return;
                  void ipc
                    .deleteDashboard(boardName)
                    .then(() => {
                      refreshBoards();
                      switchBoard(DEFAULT_BOARD);
                    })
                    .catch(() => undefined);
                }}
              >
                {t.bd_delete_board ?? "Delete board"}
              </button>
            ) : null}
            <button
              className="btn btn-primary"
              onClick={() => {
                setEdit(false);
                setEditing(null);
              }}
            >
              {t.bd_done ?? "Done"}
            </button>
          </>
        ) : (
          <button className="btn btn-ghost" onClick={() => setEdit(true)}>
            <Icon name="edit" size={12} /> {t.bd_edit ?? "Edit board"}
          </button>
        )}
      </div>

      {/* The measuring div renders UNCONDITIONALLY: useContainerWidth only
          attaches its ResizeObserver on the effect run where the ref is
          non-null, and never retries. Mounting it lazily (only once widgets
          existed) left the width stuck at the hook's 1280px default — every
          board that started empty laid out for a phantom double-wide grid,
          pushing the second column off the pane. (Ref cast: the hook types
          for React 19's nullable RefObject; React 18's div ref wants the
          non-null flavor — same object.) */}
      <div ref={containerRef as RefObject<HTMLDivElement>}>
        {doc.widgets.length === 0 ? (
          <button
            type="button"
            className="board-empty"
            onClick={() => {
              setEdit(true);
            }}
          >
            ＋ {t.bd_empty ?? "Add your first chart — MCP inflow, tags, tasks…"}
          </button>
        ) : (
          <>
          {mounted && width > 0 ? (
            <GridLayout
              width={width}
              layout={layout}
              gridConfig={{ cols: BOARD_COLS, rowHeight: BOARD_ROW_PX, margin: [8, 8] }}
              dragConfig={{ enabled: edit, handle: ".bw-grip" }}
              resizeConfig={{ enabled: edit }}
              compactor={doc.compact === "none" ? noCompactor : verticalCompactor}
              onLayoutChange={(l) => {
                // Edit mode never hides widgets, so `l` is complete there; a
                // view-mode reflow (hidden widgets filtered out) must not be
                // saved or the hidden items' positions would be dropped.
                if (!edit) return;
                const next = l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
                if (JSON.stringify(next) !== JSON.stringify(doc.layout))
                  update({ ...doc, layout: next });
              }}
            >
              {visibleWidgets.map((w) => (
                <div
                  key={w.id}
                  className={"bw" + (!edit && w.kind === "query" ? " bw--clickable" : "")}
                  onClick={
                    !edit && w.kind === "query" ? () => setDetailId(w.id) : undefined
                  }
                >
                  <header className="bw-head">
                    {edit ? (
                      <span className="bw-grip" title={t.bd_drag ?? "Drag"}>
                        ⠿
                      </span>
                    ) : null}
                    <b className="bw-title">{w.title || autoTitle(t, w) || " "}</b>
                    {edit ? (
                      <span className="bw-actions">
                        <button
                          className="bw-btn"
                          aria-label={t.bd_configure ?? "Configure"}
                          onClick={() => setEditing(editing === w.id ? null : w.id)}
                        >
                          ⚙
                        </button>
                        <button
                          className="bw-btn"
                          aria-label={t.bd_duplicate ?? "Duplicate"}
                          onClick={() => update(duplicateWidget(doc, w.id))}
                        >
                          ⧉
                        </button>
                        <button
                          className="bw-btn"
                          aria-label={t.ui_close ?? "Remove"}
                          onClick={() => update(removeWidget(doc, w.id))}
                        >
                          ✕
                        </button>
                      </span>
                    ) : null}
                  </header>
                  {edit && editing === w.id ? (
                    <WidgetEditor
                      t={t}
                      w={w}
                      facets={facets}
                      onChange={(nw) =>
                        update({
                          ...doc,
                          widgets: doc.widgets.map((x) => (x.id === w.id ? nw : x)),
                        })
                      }
                    />
                  ) : (
                    widgetBody(w)
                  )}
                </div>
              ))}
            </GridLayout>
          ) : null}
          </>
        )}
      </div>
      {detailId
        ? (() => {
            const w = doc.widgets.find((x) => x.id === detailId);
            if (!w || w.kind !== "query" || !w.query) return null;
            const r = runBoardQuery(data, w.query, effectiveRange(w, doc.range), Date.now());
            const rows =
              r.kind === "cat"
                ? r.rows.map((x) => ({
                    label: aliasLabel(w, w.query?.groupBy === "tag" ? `#${x.label}` : x.label),
                    value: x.value,
                  }))
                : r.days
                    .filter((d) => d.total > 0)
                    .map((d) => ({ label: d.day, value: d.total }))
                    .reverse();
            return (
              <div
                className="myco-modal__backdrop"
                role="dialog"
                aria-modal="true"
                aria-label={w.title || autoTitle(t, w)}
                onClick={() => setDetailId(null)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setDetailId(null);
                }}
              >
                <div
                  className="myco-modal board-detail"
                  onClick={(e) => e.stopPropagation()}
                >
                  <header className="bw-head">
                    <b style={{ fontSize: 15 }}>{w.title || autoTitle(t, w)}</b>
                    <span className="bw-actions" style={{ marginLeft: "auto" }}>
                      <button
                        className="bw-btn"
                        aria-label={t.ui_close ?? "Close"}
                        onClick={() => setDetailId(null)}
                      >
                        ✕
                      </button>
                    </span>
                  </header>
                  <p className="muted board-detail__meta">
                    {autoTitle(t, w)} · {rangeLabel(t, effectiveRange(w, doc.range))} ·{" "}
                    {(t.bd_detail_total ?? "Total {n}").replace(
                      "{n}",
                      String(statValue(r)),
                    )}
                  </p>
                  <div className="board-detail__chart">
                    {r.kind === "series" ? (
                      (w.view ?? "bar") === "line" ? (
                        <DayLine days={r.days} lang={lang} color={w.color} />
                      ) : (
                        <DayBars days={r.days} lang={lang} color={w.color} />
                      )
                    ) : (
                      <HBars
                        rows={rows.map((x) => ({
                          label: x.label,
                          count: x.value,
                          color:
                            w.query?.groupBy === "type"
                              ? (TYPE_COLORS[x.label] ?? "var(--ink-3)")
                              : w.color,
                        }))}
                      />
                    )}
                  </div>
                  <div className="board-detail__table">
                    <CatTable rows={rows} />
                  </div>
                </div>
              </div>
            );
          })()
        : null}
    </section>
  );
}

// --- widget editor -----------------------------------------------------------

const GROUPS: Record<BoardSource, string[]> = {
  inflow: ["day", "channel"],
  notes: ["type", "confidence", "status", "tag", "day"],
  tasks: ["status"],
};
const VIEWS: BoardView[] = ["bar", "line", "hbar", "stat", "table"];

function WidgetEditor({
  t,
  w,
  facets,
  onChange,
}: {
  t: Strings;
  w: BoardWidget;
  facets: ReturnType<typeof facetValues> | null;
  onChange: (w: BoardWidget) => void;
}): JSX.Element {
  // Raw-JSON escape hatch (HA's "Show code editor"): whatever the form
  // cannot express stays reachable, and the widget's full definition is
  // copy-pasteable. Draft commits on blur; a parse failure keeps the draft
  // and the warning instead of eating the edit.
  const [showJson, setShowJson] = useState(false);
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const [jsonBad, setJsonBad] = useState(false);
  const jsonToggle = (
    <div className="bw-jsonbar">
      <button
        type="button"
        className="bw-btn"
        aria-pressed={showJson}
        onClick={() => {
          setJsonDraft(null);
          setJsonBad(false);
          setShowJson((v) => !v);
        }}
      >
        {showJson ? (t.bd_json_form ?? "Form") : "JSON"}
      </button>
    </div>
  );
  if (showJson) {
    return (
      <div className="bw-editor">
        {jsonToggle}
        <textarea
          className="input bw-json"
          rows={9}
          spellCheck={false}
          value={jsonDraft ?? JSON.stringify(w, null, 2)}
          onChange={(e) => setJsonDraft(e.target.value)}
          onBlur={() => {
            if (jsonDraft === null) return;
            try {
              const parsed = JSON.parse(jsonDraft) as BoardWidget;
              onChange({ ...parsed, id: w.id }); // the id is the grid's key
              setJsonDraft(null);
              setJsonBad(false);
            } catch {
              setJsonBad(true);
            }
          }}
        />
        {jsonBad ? (
          <p className="task-detail-warn">
            {t.bd_json_bad ?? "Not valid JSON — fix it or switch back to the form."}
          </p>
        ) : null}
      </div>
    );
  }
  if (w.kind !== "query" || !w.query) {
    return (
      <div className="bw-editor">
        {jsonToggle}
        <label className="bw-field">
          <span>{t.bd_field_title ?? "Title"}</span>
          <input
            className="input"
            value={w.title ?? ""}
            onChange={(e) => onChange({ ...w, title: e.target.value })}
          />
        </label>
        <label className="bw-field bw-field--stack">
          <span>{w.kind === "heading" ? (t.bd_heading ?? "Heading") : (t.bd_text ?? "Text")}</span>
          <textarea
            className="input"
            rows={w.kind === "heading" ? 1 : 4}
            value={w.text ?? ""}
            onChange={(e) => onChange({ ...w, text: e.target.value })}
          />
        </label>
      </div>
    );
  }
  const q = w.query;
  // Filterable fields + their value options come from the live data, so no
  // filter can be typed that matches nothing by construction.
  const filterOptions: { field: string; values: string[] }[] =
    q.source === "inflow"
      ? [{ field: "channel", values: [...CHANNELS] }]
      : q.source === "tasks"
        ? [{ field: "status", values: ["todo", "doing", "blocked", "done"] }]
        : [
            { field: "type", values: (facets?.types ?? []).map((f) => f.value) },
            { field: "confidence", values: (facets?.confidence ?? []).map((f) => f.value) },
            { field: "status", values: (facets?.status ?? []).map((f) => f.value) },
            { field: "tag", values: (facets?.tags ?? []).map((f) => f.value) },
            { field: "sourceCount", values: ["0"] },
          ];
  const filter = q.filters[0] ?? null;
  const setQuery = (patch: Partial<typeof q>): void =>
    onChange({ ...w, query: { ...q, ...patch } });
  const rule = w.colorRules?.[0] ?? null;
  return (
    <div className="bw-editor">
      {jsonToggle}
      <label className="bw-field">
        <span>{t.bd_field_title ?? "Title"}</span>
        <input
          className="input"
          placeholder={autoTitle(t, w)}
          value={w.title ?? ""}
          onChange={(e) => onChange({ ...w, title: e.target.value || undefined })}
        />
      </label>
      <label className="bw-field">
        <span>{t.bd_field_source ?? "Source"}</span>
        <select
          className="input"
          value={q.source}
          onChange={(e) => {
            const source = e.target.value as BoardSource;
            setQuery({ source, groupBy: GROUPS[source][0], filters: [] });
          }}
        >
          <option value="inflow">{t.bd_src_inflow ?? "Inflow"}</option>
          <option value="notes">{t.bd_src_notes ?? "Notes"}</option>
          <option value="tasks">{t.bd_src_tasks ?? "Tasks"}</option>
        </select>
      </label>
      <label className="bw-field">
        <span>{t.bd_field_group ?? "Group by"}</span>
        <select
          className="input"
          value={q.groupBy}
          onChange={(e) => setQuery({ groupBy: e.target.value })}
        >
          {GROUPS[q.source].map((g) => (
            <option key={g} value={g}>
              {groupLabel(t, g)}
            </option>
          ))}
        </select>
      </label>
      <label className="bw-field">
        <span>{t.bd_field_filter ?? "Filter"}</span>
        <span className="bw-filter">
          <select
            className="input"
            value={filter?.field ?? ""}
            onChange={(e) => {
              const field = e.target.value;
              if (!field) return setQuery({ filters: [] });
              const opt = filterOptions.find((o) => o.field === field);
              setQuery({ filters: [{ field, value: opt?.values[0] ?? "" }] });
            }}
          >
            <option value="">{t.bd_filter_none ?? "None"}</option>
            {filterOptions.map((o) => (
              <option key={o.field} value={o.field}>
                {o.field}
              </option>
            ))}
          </select>
          {filter ? (
            <select
              className="input"
              value={filter.value}
              onChange={(e) =>
                setQuery({ filters: [{ field: filter.field, value: e.target.value }] })
              }
            >
              {(filterOptions.find((o) => o.field === filter.field)?.values ?? []).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : null}
        </span>
      </label>
      <label className="bw-field">
        <span>{t.bd_field_view ?? "View"}</span>
        <select
          className="input"
          value={w.view ?? "hbar"}
          onChange={(e) => onChange({ ...w, view: e.target.value as BoardView })}
        >
          {VIEWS.map((v) => (
            <option key={v} value={v}>
              {viewLabel(t, v)}
            </option>
          ))}
        </select>
      </label>
      <label className="bw-field">
        <span>{t.bd_field_time ?? "Range"}</span>
        <select
          className="input"
          value={w.time ?? "auto"}
          onChange={(e) => onChange({ ...w, time: e.target.value as BoardWidget["time"] })}
        >
          <option value="auto">{t.bd_time_auto ?? "Auto (board)"}</option>
          {RANGES.map((r) => (
            <option key={r} value={r}>
              {rangeLabel(t, r)}
            </option>
          ))}
        </select>
      </label>
      <label className="bw-field">
        <span>{t.bd_field_color ?? "Color"}</span>
        <select
          className="input"
          value={w.color ?? ""}
          onChange={(e) => onChange({ ...w, color: e.target.value || undefined })}
        >
          <option value="">{t.bd_color_default ?? "Default"}</option>
          <option value="var(--c-overview)">{t.bd_color_blue ?? "Blue"}</option>
          <option value="var(--c-entity)">{t.bd_color_green ?? "Green"}</option>
          <option value="var(--c-concept)">{t.bd_color_purple ?? "Purple"}</option>
          <option value="var(--c-source)">{t.bd_color_amber ?? "Amber"}</option>
          <option value="var(--c-analysis)">{t.bd_color_cyan ?? "Cyan"}</option>
          <option value="var(--c-technique)">{t.bd_color_red ?? "Red"}</option>
        </select>
      </label>
      <label className="bw-field">
        <span>{t.bd_hide_zero ?? "Hide when zero"}</span>
        <input
          type="checkbox"
          checked={w.hideWhenZero ?? false}
          onChange={(e) =>
            onChange({ ...w, hideWhenZero: e.target.checked || undefined })
          }
        />
      </label>
      {(w.view ?? "hbar") === "stat" ? (
        <label className="bw-field">
          <span>{t.bd_field_rule ?? "Color rule"}</span>
          <span className="bw-filter">
            <select
              className="input"
              value={rule ? rule.op : ""}
              onChange={(e) => {
                const op = e.target.value as "" | ">=" | ">" | "<=" | "<" | "=";
                onChange({
                  ...w,
                  colorRules: op
                    ? [{ op, value: rule?.value ?? 10, color: rule?.color ?? "risk" }]
                    : undefined,
                });
              }}
            >
              <option value="">{t.bd_filter_none ?? "None"}</option>
              {[">=", ">", "<=", "<", "="].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {rule ? (
              <>
                <input
                  className="input bw-rule-num"
                  type="number"
                  value={rule.value}
                  onChange={(e) =>
                    onChange({
                      ...w,
                      colorRules: [{ ...rule, value: Number(e.target.value) }],
                    })
                  }
                />
                <select
                  className="input"
                  value={rule.color}
                  onChange={(e) =>
                    onChange({
                      ...w,
                      colorRules: [{ ...rule, color: e.target.value as "risk" | "ok" }],
                    })
                  }
                >
                  <option value="risk">{t.bd_rule_risk ?? "red"}</option>
                  <option value="ok">{t.bd_rule_ok ?? "green"}</option>
                </select>
              </>
            ) : null}
          </span>
        </label>
      ) : null}
    </div>
  );
}
