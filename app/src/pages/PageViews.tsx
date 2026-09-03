// Views page — a Dataview-lite over the wiki's frontmatter. Compose typed
// filters (type / confidence / status / tag / sources / orphans / text) over
// the metadata the link scanner already ships (adjacency.meta + tags), see the
// result as a sortable table, and pin the composition as a named saved view
// (.myco/views/*.json). Everything is pure and in-memory — lib/queryViews.ts.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import { ipc } from "../lib/ipc";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { flattenMarkdown } from "../lib/graphData";
import {
  BUILTIN_LENSES,
  facetValues,
  loadVaultViews,
  runView,
  saveVaultView,
  wikiPagesOnly,
  type SavedView,
  type ViewFilter,
  type ViewRow,
  type ViewSort,
} from "../lib/queryViews";
import {
  FM_STATUS,
  FM_TYPES,
  normalizeTag,
  tagsOf,
  type FmPatch,
  type Frontmatter,
} from "../lib/frontmatter";
import { isComposingKey } from "../lib/ime";
import { confirmAction, promptText } from "../stores/dialogStore";
import { sanitizeNoteName } from "../lib/newNote";
import ChipInput from "../components/ChipInput";

const EMPTY: ViewFilter = {};

type CellKey = "type" | "status" | "tags";

/** Short local date for the Modified column; an em dash while the mtime map
 *  is still loading (or for a file that vanished). Intl, not a hand-rolled
 *  format — the app ships in three languages. */
function formatDay(unixSecs: number, lang: string): string {
  if (!unixSecs) return "—";
  return new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" }).format(
    new Date(unixSecs * 1000),
  );
}

export default function PageViews({ t }: { t: Strings }): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  const adjacency = useVaultStore((s) => s.adjacency);
  const vaultPath = useVaultStore((s) => s.currentVault?.path);
  const lang = useUIStore((s) => s.lang);
  const fileTree = useVaultStore((s) => s.fileTree);

  const [filter, setFilter] = useState<ViewFilter>(EMPTY);
  const [sort, setSort] = useState<ViewSort>("name");
  const [desc, setDesc] = useState(false);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewsState, setViewsState] = useState<"loading" | "ready" | "error">("loading");
  // Last save/delete failure; Rust's name validation lands here too.
  const [ioError, setIoError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<string | null>(null);
  // Which built-in lens is showing, if any. Cleared by any hand edit — the
  // chip must never claim to describe a table the user has since changed.
  const [activeLens, setActiveLens] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ path: string; key: CellKey } | null>(null);
  // Cell whose button re-mounts with autoFocus once its editor closes.
  const [focusBack, setFocusBack] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const patchPages = useVaultStore((s) => s.patchPages);
  const storeErr = useVaultStore((s) => s.error);

  // Wiki pages only: every filter on this page reads wiki frontmatter, and
  // the vault's sessions/ + daily/ notes carry none — they used to fill the
  // table with rows of dashes (1,647 rows for 92 real pages).
  const files = useMemo(
    () => wikiPagesOnly(flattenMarkdown(fileTree), vaultPath),
    [fileTree, vaultPath],
  );
  const facets = useMemo(
    () => (adjacency ? facetValues(adjacency, files) : null),
    [adjacency, files],
  );
  // Modified dates: the one column that answers "what changed lately", which
  // adjacency does not carry. One call per vault, refreshed when it changes.
  const [mtimes, setMtimes] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!vaultPath) return;
    let cancelled = false;
    void ipc
      .fileMtimes(vaultPath)
      .then((pairs) => {
        if (!cancelled) setMtimes(new Map(pairs));
      })
      .catch(() => {
        // A missing mtime map costs the column its values, nothing else.
        if (!cancelled) setMtimes(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  // Saved views are files in the vault, so they follow the vault, not the app.
  useEffect(() => {
    if (!vaultPath) return;
    let cancelled = false;
    setViewsState("loading");
    loadVaultViews(vaultPath)
      .then((list) => {
        if (cancelled) return;
        setViews(list);
        setViewsState("ready");
      })
      .catch(() => {
        if (!cancelled) setViewsState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  const rows = useMemo(
    () => (adjacency ? runView(adjacency, files, filter, sort, desc, mtimes) : []),
    [adjacency, files, filter, sort, desc, mtimes],
  );

  // Only visible rows take part in a bulk edit, even if a filter change hid
  // some rows that were ticked earlier.
  const chosen = rows.filter((r) => selected.has(r.path)).map((r) => r.path);
  const tagList = facets?.tags.map((f) => f.value) ?? [];

  function closeCell(): void {
    if (editing) setFocusBack(`${editing.path}:${editing.key}`);
    setEditing(null);
  }

  /** Canonical values first, then whatever the vault already uses. */
  function options(key: "type" | "status", current?: string): string[] {
    const canon = key === "type" ? FM_TYPES : FM_STATUS;
    const present = (key === "type" ? facets?.types : facets?.status) ?? [];
    return [
      ...new Set([...canon, ...present.map((f) => f.value), ...(current ? [current] : [])]),
    ];
  }

  async function bulk(make: (fm: Frontmatter | null) => FmPatch): Promise<void> {
    const ok = await confirmAction({
      title: t.vw_bulk_title ?? "Bulk edit",
      message: (t.vw_bulk_confirm ?? "Apply to {n} pages?").replace(
        "{n}",
        String(chosen.length),
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await patchPages(chosen, make);
    } finally {
      setBusy(false);
    }
  }

  function cell(r: ViewRow, key: CellKey): JSX.Element {
    const id = `${r.path}:${key}`;
    if (editing?.path === r.path && editing.key === key) {
      if (key === "tags")
        return (
          <>
            <ChipInput
              autoFocus
              chips={r.tags}
              setChips={(next) => {
                // Delta over the re-read file, not a snapshot: r.tags lags until the
                // graph refresh, so a second quick add must not replay the stale list.
                const gone = r.tags.filter((x) => !next.includes(x));
                const added = next.filter((x) => !r.tags.includes(x));
                void patchPages([r.path], (fm) => ({
                  tags: [
                    ...new Set([
                      ...tagsOf(fm).filter((x) => !gone.includes(x)),
                      ...added,
                    ]),
                  ],
                }));
              }}
              suggestions={tagList}
              placeholder={t.props_tags_ph ?? "Add tag…"}
              listId="views-cell-tags"
              disabled={busy}
              prefix="#"
              removeTitle={t.props_tag_remove ?? "Remove tag"}
            />
            <button type="button" className="btn" onClick={closeCell}>
              {t.vw_edit_done ?? "Done"}
            </button>
          </>
        );
      return (
        <select
          autoFocus
          className="input"
          value={r[key] ?? ""}
          onChange={(e) => {
            // Read now: React restores the controlled value before `make` runs.
            const v = e.target.value || undefined;
            void patchPages([r.path], () => ({ [key]: v }));
            closeCell();
          }}
          onBlur={closeCell}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeCell();
          }}
        >
          <option value="">{t.vw_unset ?? "(none)"}</option>
          {options(key, r[key]).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
    }
    const text = key === "tags" ? r.tags.map((x) => `#${x}`).join(" ") : r[key];
    return (
      <button
        type="button"
        className="views-cell"
        title={t.vw_edit_cell ?? "Click to edit"}
        autoFocus={focusBack === id}
        onFocus={() => {
          if (focusBack === id) setFocusBack(null);
        }}
        onClick={() => setEditing({ path: r.path, key })}
      >
        {text || "—"}
      </button>
    );
  }

  function patch(p: Partial<ViewFilter>): void {
    setFilter((f) => ({ ...f, ...p }));
    setActiveView(null);
    setActiveLens(null);
  }

  function applyView(v: SavedView): void {
    setFilter(v.filter);
    setSort(v.sort);
    setDesc(v.desc);
    setActiveView(v.id);
    setActiveLens(null);
  }

  async function saveCurrent(): Promise<void> {
    const raw = await promptText({
      title: t.vw_save ?? "Save view",
      message: t.vw_save_prompt ?? "Name this view:",
    });
    // The file stem is the view's id and name, so it obeys note-name rules
    // (and Rust's 60-char cap; trimmed again so the stem matches the name).
    const name = raw == null ? null : sanitizeNoteName(raw)?.slice(0, 60).trim();
    if (!name) return;
    if (views.some((v) => v.id === name)) {
      const ok = await confirmAction({
        title: t.vw_save ?? "Save view",
        message: (t.vw_overwrite_q ?? "Replace the saved view “{name}”?").replace("{name}", name),
      });
      if (!ok) return;
    }
    const v: SavedView = { id: name, name, filter, sort, desc };
    try {
      await saveVaultView(v);
    } catch (e) {
      setIoError(String(e));
      return;
    }
    setIoError(null);
    setViews((prev) => [...prev.filter((x) => x.id !== name), v]);
    setActiveView(name);
  }

  async function removeView(v: SavedView): Promise<void> {
    try {
      await ipc.deleteView(v.name);
    } catch (e) {
      setIoError(String(e));
      return;
    }
    setIoError(null);
    setViews((prev) => prev.filter((x) => x.id !== v.id));
    if (activeView === v.id) setActiveView(null);
  }

  function header(label: string, key: ViewSort): JSX.Element {
    const active = sort === key;
    return (
      <th>
        <button
          type="button"
          className={"views-sort" + (active ? " active" : "")}
          onClick={() => {
            if (active) setDesc((d) => !d);
            else {
              setSort(key);
              setDesc(key !== "name");
            }
          }}
        >
          {label}
          {active ? (desc ? " ↓" : " ↑") : ""}
        </button>
      </th>
    );
  }

  const one = (v: string[] | undefined): string => (v && v.length > 0 ? v[0] : "");
  const asList = (v: string): string[] | undefined => (v ? [v] : undefined);

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_views ?? "Views"}</div>
        <h1 className="page-title">{t.vw_title ?? "Query views"}</h1>
        <p className="page-lede">
          {t.vw_lede ??
            "Filter the wiki by its frontmatter — type, confidence, status, tags, sources — and save the lenses you keep coming back to."}
        </p>
      </header>

      <div className="views-saved views-lenses">
        {BUILTIN_LENSES.map((lens) => (
          <span
            key={lens.key}
            className={"views-chip" + (activeLens === lens.key ? " active" : "")}
          >
            <button
              type="button"
              onClick={() => {
                setFilter(lens.filter);
                setSort(lens.sort);
                setDesc(lens.desc);
                setActiveLens(lens.key);
                setActiveView(null);
              }}
            >
              {t[lens.labelKey as keyof Strings]?.toString() ?? lens.fallback}
            </button>
          </span>
        ))}
      </div>

      {viewsState === "error" ? (
        <p role="alert" className="muted">
          {t.vw_load_error ?? "Saved views could not be read from .myco/views/."}
        </p>
      ) : views.length > 0 ? (
        <div className="views-saved">
          {views.map((v) => (
            <span key={v.id} className={"views-chip" + (activeView === v.id ? " active" : "")}>
              <button type="button" onClick={() => applyView(v)}>
                {v.name}
              </button>
              <button
                type="button"
                className="views-chip__x"
                aria-label={t.ui_close ?? "Remove"}
                onClick={() => void removeView(v)}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {ioError ? (
        <p role="alert" className="muted">
          {(t.vw_io_error ?? "Could not update saved views: {err}").replace("{err}", ioError)}
        </p>
      ) : null}

      <div className="views-filters">
        <input
          className="input"
          placeholder={t.vw_search ?? "Filter by name…"}
          value={filter.text ?? ""}
          onChange={(e) => patch({ text: e.target.value || undefined })}
        />
        <select
          className="input"
          value={one(filter.types)}
          onChange={(e) => patch({ types: asList(e.target.value) })}
        >
          <option value="">{t.vw_any_type ?? "Any type"}</option>
          {facets?.types.map((f) => (
            <option key={f.value} value={f.value}>
              {f.value} ({f.count})
            </option>
          ))}
        </select>
        <select
          className="input"
          value={one(filter.confidence)}
          onChange={(e) => patch({ confidence: asList(e.target.value) })}
        >
          <option value="">{t.vw_any_conf ?? "Any confidence"}</option>
          {facets?.confidence.map((f) => (
            <option key={f.value} value={f.value}>
              {f.value} ({f.count})
            </option>
          ))}
        </select>
        <select
          className="input"
          value={one(filter.status)}
          onChange={(e) => patch({ status: asList(e.target.value) })}
        >
          <option value="">{t.vw_any_status ?? "Any status"}</option>
          {facets?.status.map((f) => (
            <option key={f.value} value={f.value}>
              {f.value} ({f.count})
            </option>
          ))}
        </select>
        <select
          className="input"
          value={one(filter.tags)}
          onChange={(e) => patch({ tags: asList(e.target.value) })}
        >
          <option value="">{t.vw_any_tag ?? "Any tag"}</option>
          {facets?.tags.map((f) => (
            <option key={f.value} value={f.value}>
              #{f.value} ({f.count})
            </option>
          ))}
        </select>
        <label className="views-check">
          <input
            type="checkbox"
            checked={filter.orphansOnly ?? false}
            onChange={(e) => patch({ orphansOnly: e.target.checked || undefined })}
          />
          {t.vw_orphans ?? "Orphans only"}
        </label>
        <button type="button" className="btn" onClick={() => void saveCurrent()}>
          <Icon name="save" size={13} /> {t.vw_save ?? "Save view"}
        </button>
      </div>

      {chosen.length > 0 ? (
        <div
          role="toolbar"
          className="views-filters"
          aria-label={t.vw_bulk_title ?? "Bulk edit"}
        >
          <span className="views-chip">
            {(t.vw_selected_n ?? "{n} selected").replace("{n}", String(chosen.length))}
            <button
              type="button"
              className="views-chip__x"
              aria-label={t.vw_clear_sel ?? "Clear selection"}
              disabled={busy}
              onClick={() => setSelected(new Set())}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
          <select
            className="input"
            value=""
            disabled={busy}
            aria-label={t.vw_bulk_type ?? "Set type…"}
            onChange={(e) => {
              const v = e.target.value;
              if (v) void bulk(() => ({ type: v }));
            }}
          >
            <option value="">{t.vw_bulk_type ?? "Set type…"}</option>
            {options("type").map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select
            className="input"
            value=""
            disabled={busy}
            aria-label={t.vw_bulk_status ?? "Set status…"}
            onChange={(e) => {
              const v = e.target.value;
              if (v) void bulk(() => ({ status: v }));
            }}
          >
            <option value="">{t.vw_bulk_status ?? "Set status…"}</option>
            {options("status").map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <input
            className="input"
            list="views-bulk-tags"
            placeholder={t.vw_bulk_add_tag ?? "Add tag…"}
            aria-label={t.vw_bulk_add_tag ?? "Add tag…"}
            disabled={busy}
            onKeyDown={(e) => {
              if (isComposingKey(e) || e.key !== "Enter") return;
              const tag = normalizeTag(e.currentTarget.value);
              if (!tag) return;
              e.currentTarget.value = "";
              void bulk((fm) => ({ tags: [...new Set([...tagsOf(fm), tag])] }));
            }}
          />
          <datalist id="views-bulk-tags">
            {tagList.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          {storeErr ? (
            <span role="alert" className="muted">
              {(t.vw_edit_failed ?? "Could not save: {msg}").replace("{msg}", storeErr)}
            </span>
          ) : null}
        </div>
      ) : null}

      <p className="muted views-count">
        {rows.length} {t.vw_pages ?? "pages"}
      </p>

      {rows.length === 0 ? (
        <p className="muted">{t.vw_empty ?? "No pages match this view."}</p>
      ) : (
        <div className="views-table-wrap">
          <table className="views-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label={t.vw_select_all ?? "Select all rows"}
                    checked={chosen.length === rows.length}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(rows.map((r) => r.path)) : new Set())
                    }
                  />
                </th>
                {header(t.vw_col_name ?? "Page", "name")}
                {header(t.vw_col_type ?? "Type", "type")}
                <th>{t.vw_col_conf ?? "Confidence"}</th>
                {/* Status was filterable but invisible — you narrowed by a
                    value the table would not show you. */}
                <th>{t.vw_col_status ?? "Status"}</th>
                {header(t.vw_col_sources ?? "Sources", "sources")}
                {header(t.vw_col_links ?? "Links", "links")}
                {header(t.vw_col_modified ?? "Modified", "modified")}
                <th>{t.vw_col_tags ?? "Tags"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={(t.vw_select_row ?? "Select {name}").replace("{name}", r.name)}
                      checked={selected.has(r.path)}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(r.path);
                          else next.delete(r.path);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="views-page"
                      title={r.path}
                      onClick={() => setRoute(`page:${r.path}`)}
                    >
                      {r.name}
                    </button>
                  </td>
                  <td>{cell(r, "type")}</td>
                  <td>{r.confidence ?? "—"}</td>
                  <td>{cell(r, "status")}</td>
                  <td className="num">{r.sourceCount}</td>
                  <td className="num">{r.links}</td>
                  <td className="num">{formatDay(r.modified, lang)}</td>
                  <td className="views-tags">{cell(r, "tags")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
