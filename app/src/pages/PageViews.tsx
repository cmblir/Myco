// Views page — a Dataview-lite over the wiki's frontmatter. Compose typed
// filters (type / confidence / status / tag / sources / orphans / text) over
// the metadata the link scanner already ships (adjacency.meta + tags), see the
// result as a sortable table, and pin the composition as a named saved view
// (localStorage). Everything is pure and in-memory — lib/queryViews.ts.

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
  loadViews,
  runView,
  saveViews,
  wikiPagesOnly,
  type SavedView,
  type ViewFilter,
  type ViewSort,
} from "../lib/queryViews";

const EMPTY: ViewFilter = {};

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
  const [views, setViews] = useState<SavedView[]>(() => loadViews());
  const [activeView, setActiveView] = useState<string | null>(null);
  // Which built-in lens is showing, if any. Cleared by any hand edit — the
  // chip must never claim to describe a table the user has since changed.
  const [activeLens, setActiveLens] = useState<string | null>(null);

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

  const rows = useMemo(
    () => (adjacency ? runView(adjacency, files, filter, sort, desc, mtimes) : []),
    [adjacency, files, filter, sort, desc, mtimes],
  );

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

  function saveCurrent(): void {
    const name = window.prompt(t.vw_save_prompt ?? "Name this view:");
    if (!name?.trim()) return;
    const v: SavedView = {
      id: `${Date.now().toString(36)}`,
      name: name.trim(),
      filter,
      sort,
      desc,
    };
    const next = [...views, v];
    setViews(next);
    saveViews(next);
    setActiveView(v.id);
  }

  function removeView(id: string): void {
    const next = views.filter((v) => v.id !== id);
    setViews(next);
    saveViews(next);
    if (activeView === id) setActiveView(null);
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

      {views.length > 0 ? (
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
                onClick={() => removeView(v.id)}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
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
        <button type="button" className="btn" onClick={saveCurrent}>
          <Icon name="save" size={13} /> {t.vw_save ?? "Save view"}
        </button>
      </div>

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
                    <button
                      type="button"
                      className="views-page"
                      title={r.path}
                      onClick={() => setRoute(`page:${r.path}`)}
                    >
                      {r.name}
                    </button>
                  </td>
                  <td>{r.type ?? "—"}</td>
                  <td>{r.confidence ?? "—"}</td>
                  <td>{r.status ?? "—"}</td>
                  <td className="num">{r.sourceCount}</td>
                  <td className="num">{r.links}</td>
                  <td className="num">{formatDay(r.modified, lang)}</td>
                  <td className="views-tags">{r.tags.map((x) => `#${x}`).join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
