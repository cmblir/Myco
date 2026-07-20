// Command palette (⌘K). Searches navigation routes and vault file leaves.

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Icon } from "../lib/icons";
import type { IconName } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { ipc } from "../lib/ipc";
import { BUILTIN_MODEL } from "../lib/providers";
import type { FileNode, SearchHit, VecHit } from "../lib/ipc";
import { isComposingKey } from "../lib/ime";

interface CmdEntry {
  type: "nav" | "page";
  label: string;
  to: RouteId;
}

export default function CommandBar({ t }: { t: Strings }): JSX.Element | null {
  const open = useUIStore((s) => s.cmdOpen);
  const setCmdOpen = useUIStore((s) => s.setCmdOpen);
  const setRoute = useUIStore((s) => s.setRoute);
  const fileTree = useVaultStore((s) => s.fileTree);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [q, setQ] = useState("");
  const [contentHits, setContentHits] = useState<SearchHit[]>([]);
  // Semantic (embedding) hits — meaning matches even when the exact words differ.
  const [semanticHits, setSemanticHits] = useState<VecHit[]>([]);
  // Index into the combined result list (filtered entries first, then
  // contentHits). Keyboard arrows move it; Enter activates the selected row.
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
    if (!open) setQ("");
  }, [open]);

  // Reset selection to the top whenever the query changes.
  useEffect(() => {
    setSelected(0);
  }, [q]);

  // Full-text search across page contents, debounced. Names/routes are matched
  // locally above; this adds matches found inside the markdown bodies.
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) {
      setContentHits([]);
      setSemanticHits([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      ipc
        .searchVault(needle, 20)
        .then((hits) => {
          if (!cancelled) setContentHits(hits);
        })
        .catch(() => {
          if (!cancelled) setContentHits([]);
        });
      // Semantic hits run in parallel; empty when no index is built (quiet fail).
      ipc
        .semanticSearch(needle, 6, "builtin-local", BUILTIN_MODEL)
        .then((hits) => {
          if (!cancelled) setSemanticHits(hits);
        })
        .catch(() => {
          if (!cancelled) setSemanticHits([]);
        });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [q]);

  const all: CmdEntry[] = useMemo(() => {
    const navs: CmdEntry[] = [
      { type: "nav", label: t.nav_overview, to: "overview" },
      { type: "nav", label: t.nav_ingest, to: "ingest" },
      { type: "nav", label: t.nav_query, to: "query" },
      { type: "nav", label: t.nav_graph, to: "graph" },
      { type: "nav", label: t.nav_history, to: "history" },
      { type: "nav", label: t.nav_provenance, to: "provenance" },
      { type: "nav", label: t.nav_tasks ?? "Tasks", to: "tasks" },
      { type: "nav", label: t.nav_tags, to: "tags" },
      { type: "nav", label: t.nav_study, to: "study" },
      { type: "nav", label: t.nav_schedules, to: "schedules" },
      { type: "nav", label: t.nav_settings, to: "settings" },
    ];
    const pages: CmdEntry[] = collectFiles(fileTree).map((n) => ({
      type: "page",
      label: n.name.replace(/\.md$/i, ""),
      to: `page:${n.path}` as RouteId,
    }));
    return [...navs, ...pages];
  }, [t, fileTree]);

  if (!open) return null;
  const filtered = q.trim()
    ? all.filter((x) => x.label.toLowerCase().includes(q.toLowerCase()))
    : all.slice(0, 12);

  // The two rendered groups form a single navigable list: nav/file entries
  // first, then full-text content hits.
  const total = filtered.length + contentHits.length + semanticHits.length;
  const active = total > 0 ? Math.min(selected, total - 1) : 0;

  function go(entry: CmdEntry): void {
    setRoute(entry.to);
    setCmdOpen(false);
  }
  function goPath(path: string): void {
    setRoute(`page:${path}` as RouteId);
    setCmdOpen(false);
  }
  // Activate the row at the given combined index.
  function activate(index: number): void {
    if (index < filtered.length) {
      const entry = filtered[index];
      if (entry) go(entry);
    } else if (index < filtered.length + contentHits.length) {
      const hit = contentHits[index - filtered.length];
      if (hit) goPath(hit.path);
    } else {
      const hit = semanticHits[index - filtered.length - contentHits.length];
      if (hit) goPath(hit.page);
    }
  }
  // Move the selection and scroll the newly-active row into view. Uses the
  // functional updater so rapid key-repeats (batched before a re-render) each
  // advance from the latest value instead of a stale closure.
  function move(delta: number): void {
    if (total === 0) return;
    setSelected((prev) => (Math.min(prev, total - 1) + delta + total) % total);
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(".cmd-row.active")
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  // Keys are handled on the PANEL, not the input: focus can sit on a row (or
  // anywhere inside), and Escape/arrows have to keep working there.
  function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    // Escape stays reachable mid-composition (it cancels the candidate, and a
    // user hitting it wants out either way); every other branch here would act
    // on a half-typed query.
    if (e.key !== "Escape" && isComposingKey(e)) return;
    if (e.key === "Escape") {
      setCmdOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      if (total > 0) activate(active);
    } else if (e.key === "Tab") {
      // The rows are not tab stops (they are reached with the arrows), so the
      // input is the only stop inside — Tab would otherwise walk focus onto the
      // page behind the modal while it stayed open.
      e.preventDefault();
      inputRef.current?.focus();
    }
  }

  const listId = "cmd-listbox";
  const rowId = (i: number): string => `cmd-opt-${i}`;

  return (
    <div className="cmd-overlay" onClick={() => setCmdOpen(false)}>
      <div
        className="cmd-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t.ph_search}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
      >
        <div className="cmd-input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            placeholder={t.ph_search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded={total > 0}
            aria-controls={listId}
            // Without this the arrow selection is background-colour only —
            // a screen reader announces nothing as it moves.
            aria-activedescendant={total > 0 ? rowId(active) : undefined}
            aria-autocomplete="list"
          />
          <span className="kbd">esc</span>
        </div>
        <div className="cmd-list" id={listId} role="listbox" ref={listRef}>
          {filtered.length === 0 &&
          contentHits.length === 0 &&
          semanticHits.length === 0 ? (
            <div className="cmd-row muted">{t.cb_no_results ?? "No results"}</div>
          ) : null}
          {filtered.map((r, i) => (
            <button
              key={`${r.type}-${r.to}-${i}`}
              id={rowId(i)}
              role="option"
              aria-selected={total > 0 && active === i}
              tabIndex={-1}
              className={`cmd-row${total > 0 && active === i ? " active" : ""}`}
              onClick={() => go(r)}
            >
              <Icon name={iconFor(r)} size={13} />
              <span>{r.label}</span>
              <span className="cr-tag">
                {r.type === "nav"
                  ? (t.cb_tag_page ?? "page")
                  : (t.cb_tag_file ?? "file")}
              </span>
            </button>
          ))}
          {contentHits.length > 0 ? (
            <div className="cmd-group-label">
              {t.cb_in_contents ?? "In page contents"}
            </div>
          ) : null}
          {contentHits.map((h, i) => (
            <button
              key={`content-${h.path}-${h.line}`}
              id={rowId(filtered.length + i)}
              role="option"
              aria-selected={active === filtered.length + i}
              tabIndex={-1}
              className={`cmd-row${
                active === filtered.length + i ? " active" : ""
              }`}
              onClick={() => goPath(h.path)}
            >
              <Icon name="search" size={13} />
              <span className="cmd-content-hit">
                <span>{h.name.replace(/\.md$/i, "")}</span>
                <span className="cmd-content-snippet">{h.snippet}</span>
              </span>
              <span className="cr-tag">L{h.line}</span>
            </button>
          ))}
          {semanticHits.length > 0 ? (
            <div className="cmd-group-label">
              {t.cb_semantic ?? "Related (semantic)"}
            </div>
          ) : null}
          {semanticHits.map((h, i) => {
            const idx = filtered.length + contentHits.length + i;
            return (
              <button
                key={`sem-${h.page}`}
                id={rowId(idx)}
                role="option"
                aria-selected={active === idx}
                tabIndex={-1}
                className={`cmd-row${active === idx ? " active" : ""}`}
                onClick={() => goPath(h.page)}
              >
                <Icon name="sparkles" size={13} />
                <span>{h.stem}</span>
                <span className="cr-tag">{(h.score * 100).toFixed(0)}%</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function iconFor(entry: CmdEntry): IconName {
  if (entry.type === "page") return "page";
  if (entry.to === "overview") return "home";
  if (entry.to === "graph") return "graph";
  if (entry.to === "history") return "history";
  if (entry.to === "provenance") return "quote";
  if (entry.to === "ingest") return "upload";
  if (entry.to === "query") return "msg";
  if (entry.to === "tags") return "book";
  if (entry.to === "study") return "sparkles";
  if (entry.to === "schedules") return "history";
  if (entry.to === "settings") return "settings";
  return "arrowR";
}

function collectFiles(tree: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  const stack = [...tree];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.kind === "file") out.push(n);
    else stack.push(...n.children);
  }
  return out;
}
