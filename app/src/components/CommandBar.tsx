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
import { BUILTIN_EMBED_MODEL } from "../lib/providers";
import type { FileNode, SearchHit, VecHit } from "../lib/ipc";
import { isComposingKey } from "../lib/ime";
import { promptNewNote } from "../lib/newNote";
import { hitPassesFilters, parseSearchQuery } from "../lib/searchQuery";

type CmdEntry =
  | { type: "nav" | "page"; label: string; to: RouteId }
  | { type: "action"; label: string; run: () => void };

export default function CommandBar({ t }: { t: Strings }): JSX.Element | null {
  const open = useUIStore((s) => s.cmdOpen);
  const setCmdOpen = useUIStore((s) => s.setCmdOpen);
  const setRoute = useUIStore((s) => s.setRoute);
  const fileTree = useVaultStore((s) => s.fileTree);
  const currentVault = useVaultStore((s) => s.currentVault);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [q, setQ] = useState("");
  // Hits for a "quoted phrase" — the substring scan run with the full phrase.
  const [exactHits, setExactHits] = useState<SearchHit[]>([]);
  const [contentHits, setContentHits] = useState<SearchHit[]>([]);
  // Semantic (embedding) hits — meaning matches even when the exact words differ.
  const [semanticHits, setSemanticHits] = useState<VecHit[]>([]);
  // Index into the combined result list (filtered entries first, then
  // exactHits, contentHits, semanticHits). Keyboard arrows move it; Enter
  // activates the selected row.
  const [selected, setSelected] = useState(0);
  // ⌥⏎ logged the current query as a recall miss — swaps the footer hint.
  const [missLogged, setMissLogged] = useState(false);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
    if (!open) setQ("");
  }, [open]);

  // Reset selection to the top whenever the query changes.
  useEffect(() => {
    setSelected(0);
    setMissLogged(false);
  }, [q]);

  // Full-text search across page contents, debounced. Names/routes are matched
  // locally above; this adds matches found inside the markdown bodies.
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) {
      setExactHits([]);
      setContentHits([]);
      setSemanticHits([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      const parsed = parseSearchQuery(needle);
      const { currentVault: vault, adjacency } = useVaultStore.getState();
      const passes = (path: string): boolean =>
        hitPassesFilters(path, vault?.path ?? "", parsed, adjacency?.tags ?? {});
      // Exact arm: the raw substring scan takes the whole quoted phrase as
      // its needle, so every hit contains it verbatim.
      const phrase = parsed.phrases[0];
      if (phrase) {
        ipc
          .searchVault(phrase, 20)
          .then((hits) => {
            if (!cancelled) setExactHits(hits.filter((h) => passes(h.path)));
          })
          .catch(() => {
            if (!cancelled) setExactHits([]);
          });
      } else {
        setExactHits([]);
      }
      // Operator-only queries (e.g. just `path:wiki/`) leave nothing to scan.
      const lexQuery = parsed.terms || parsed.phrases.join(" ");
      if (!lexQuery) {
        setContentHits([]);
        setSemanticHits([]);
        return;
      }
      ipc
        .searchVault(lexQuery, 20)
        .then((hits) => {
          if (!cancelled) setContentHits(hits.filter((h) => passes(h.path)));
        })
        .catch(() => {
          if (!cancelled) setContentHits([]);
        });
      // Semantic hits run in parallel; empty when no index is built (quiet fail).
      ipc
        .semanticSearch(lexQuery, 6, "builtin-local", BUILTIN_EMBED_MODEL)
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
    // Actions first: creating a note is the one thing the palette can DO
    // rather than merely navigate to.
    const actions: CmdEntry[] = [
      {
        type: "action",
        label: t.sb_new_note ?? "New note",
        run: () => void promptNewNote(t),
      },
    ];
    const navs: CmdEntry[] = [
      { type: "nav", label: t.nav_overview, to: "overview" },
      { type: "nav", label: t.nav_ingest, to: "ingest" },
      { type: "nav", label: t.nav_query, to: "query" },
      { type: "nav", label: t.nav_graph, to: "graph" },
      { type: "nav", label: t.nav_history, to: "history" },
      { type: "nav", label: t.nav_provenance, to: "provenance" },
      { type: "nav", label: t.nav_tasks ?? "Tasks", to: "tasks" },
      { type: "nav", label: t.nav_views ?? "Views", to: "views" },
      { type: "nav", label: t.nav_tags, to: "tags" },
      { type: "nav", label: t.nav_study, to: "study" },
      { type: "nav", label: t.nav_feedback ?? "Feedback", to: "feedback" },
      { type: "nav", label: t.nav_schedules, to: "schedules" },
      { type: "nav", label: t.nav_settings, to: "settings" },
    ];
    const pages: CmdEntry[] = collectFiles(fileTree).map((n) => ({
      type: "page",
      label: n.name.replace(/\.md$/i, ""),
      to: `page:${n.path}` as RouteId,
    }));
    return [...actions, ...navs, ...pages];
  }, [t, fileTree]);

  if (!open) return null;
  const filtered = q.trim()
    // Capped like the no-query branch below: a two-letter query over a
    // 1121-file vault otherwise renders every match into the palette.
    ? all.filter((x) => x.label.toLowerCase().includes(q.toLowerCase())).slice(0, 50)
    : all.slice(0, 12);

  // The rendered groups form a single navigable list: nav/file entries first,
  // then exact-phrase hits, full-text content hits, semantic hits.
  const exactBase = filtered.length;
  const contentBase = exactBase + exactHits.length;
  const semanticBase = contentBase + contentHits.length;
  const total = semanticBase + semanticHits.length;
  const active = total > 0 ? Math.min(selected, total - 1) : 0;

  function go(entry: CmdEntry): void {
    setCmdOpen(false);
    if (entry.type === "action") entry.run();
    else setRoute(entry.to);
  }
  function goPath(path: string): void {
    setRoute(`page:${path}` as RouteId);
    setCmdOpen(false);
  }
  /// Semantic hits carry a VAULT-RELATIVE `page` (that is how the embedding
  /// index keys them), while the `page:` route hands its path straight to
  /// ipc.readFile — so a relative path has to be rejoined to the vault root or
  /// the click dies on "canonicalize failed for wiki/…". Full-text hits already
  /// carry absolute paths and go through goPath directly.
  function goIndexedPage(relPath: string): void {
    const root = currentVault?.path;
    goPath(root && !relPath.startsWith(root) ? `${root}/${relPath}` : relPath);
  }
  // Activate the row at the given combined index.
  function activate(index: number): void {
    if (index < exactBase) {
      const entry = filtered[index];
      if (entry) go(entry);
    } else if (index < contentBase) {
      const hit = exactHits[index - exactBase];
      if (hit) goPath(hit.path);
    } else if (index < semanticBase) {
      const hit = contentHits[index - contentBase];
      if (hit) goPath(hit.path);
    } else {
      const hit = semanticHits[index - semanticBase];
      if (hit) goIndexedPage(hit.page);
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
    } else if (e.key === "Enter" && e.altKey) {
      // ⌥⏎ — log the query to the recall-miss eval set (Q4 item 5).
      e.preventDefault();
      const vault = useVaultStore.getState().currentVault;
      if (vault && q.trim().length >= 2) {
        void ipc.recordRecallMiss(vault.path, q.trim()).catch(() => undefined);
        setMissLogged(true);
      }
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
          exactHits.length === 0 &&
          contentHits.length === 0 &&
          semanticHits.length === 0 ? (
            <div className="cmd-row muted">{t.cb_no_results ?? "No results"}</div>
          ) : null}
          {filtered.map((r, i) => (
            <button
              key={`${r.type}-${r.label}-${i}`}
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
                {r.type === "action"
                  ? (t.cb_tag_action ?? "action")
                  : r.type === "nav"
                    ? (t.cb_tag_page ?? "page")
                    : (t.cb_tag_file ?? "file")}
              </span>
            </button>
          ))}
          {exactHits.length > 0 ? (
            <div className="cmd-group-label">
              {t.cb_exact ?? "Exact match"}
            </div>
          ) : null}
          {exactHits.map((h, i) => (
            <button
              key={`exact-${h.path}-${h.line}`}
              id={rowId(exactBase + i)}
              role="option"
              aria-selected={active === exactBase + i}
              tabIndex={-1}
              className={`cmd-row${active === exactBase + i ? " active" : ""}`}
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
          {contentHits.length > 0 ? (
            <div className="cmd-group-label">
              {t.cb_in_contents ?? "In page contents"}
            </div>
          ) : null}
          {contentHits.map((h, i) => (
            <button
              key={`content-${h.path}-${h.line}`}
              id={rowId(contentBase + i)}
              role="option"
              aria-selected={active === contentBase + i}
              tabIndex={-1}
              className={`cmd-row${
                active === contentBase + i ? " active" : ""
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
            const idx = semanticBase + i;
            return (
              <button
                key={`sem-${h.page}`}
                id={rowId(idx)}
                role="option"
                aria-selected={active === idx}
                tabIndex={-1}
                className={`cmd-row${active === idx ? " active" : ""}`}
                onClick={() => goIndexedPage(h.page)}
              >
                <Icon name="sparkles" size={13} />
                <span>{h.stem}</span>
                <span className="cr-tag">{(h.score * 100).toFixed(0)}%</span>
              </button>
            );
          })}
          <div className="muted" style={{ fontSize: 11.5, padding: "6px 10px 4px" }}>
            {missLogged
              ? (t.cb_miss_done ?? "Logged to the eval set.")
              : `${t.cb_operator_hint ?? "Quotes for exact match · path: · tag:"} · ${
                  t.cb_miss_hint ??
                  "Didn't find it? ⌥⏎ logs this search to the eval set."
                }`}
          </div>
        </div>
      </div>
    </div>
  );
}

function iconFor(entry: CmdEntry): IconName {
  if (entry.type === "action") return "plus";
  if (entry.type === "page") return "page";
  if (entry.to === "overview") return "home";
  if (entry.to === "graph") return "graph";
  if (entry.to === "history") return "history";
  if (entry.to === "provenance") return "quote";
  if (entry.to === "ingest") return "upload";
  if (entry.to === "query") return "msg";
  if (entry.to === "tags") return "book";
  if (entry.to === "study") return "sparkles";
  if (entry.to === "feedback") return "inbox";
  if (entry.to === "views") return "eye";
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
