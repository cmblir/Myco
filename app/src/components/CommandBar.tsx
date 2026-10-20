// Command palette (⌘K). Searches navigation routes and vault file leaves.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Icon } from "../lib/icons";
import type { IconName } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { HISTORY_CAP, recentPages } from "../lib/navHistory";
import { useTidyStore } from "../stores/tidyStore";
import { ipc } from "../lib/ipc";
import { displayName, listedName } from "../lib/displayName";
import { BUILTIN_EMBED_MODEL } from "../lib/providers";
import type { Adjacency, AuthorshipIndex, FileNode, SearchHit, VecHit } from "../lib/ipc";
import { isComposingKey } from "../lib/ime";
import { createNoteAndOpen, promptNewNote } from "../lib/newNote";
import { setQueryPrefill } from "../lib/queryPrefill";
import { cancelPickIntent, settlePick } from "../lib/askLoop";
import { flattenMarkdown } from "../lib/graphData";
import { BUILTIN_LENSES, runView, wikiPagesOnly } from "../lib/queryViews";
import type { BuiltinLens } from "../lib/queryViews";
import {
  hasOperators,
  hitPassesFilters,
  operatorSuggestions,
  parseSearchQuery,
} from "../lib/searchQuery";
import type { SuggestSources } from "../lib/searchQuery";
import { byArea, kindName, vaultRel } from "../lib/vaultAreas";
import { newNoteFromTemplate } from "./TemplatePicker";
import { returnFocus } from "./useModalFocus";
import { PHONE_QUERY, sheetFrame, useMediaQuery } from "./ui";

type CmdEntry =
  // `stem` (pages only): the file's own name — the row's tooltip, and still
  // matched when `label` shows a display name instead (lib/displayName).
  | { type: "nav" | "page"; label: string; to: RouteId; stem?: string }
  // run resolves to the note it opened (null: none) — a pick waits on it.
  | { type: "action"; label: string; run: () => Promise<string | null>; icon?: IconName }
  // A built-in lens (no sources / orphans / disputed / recent): picking one
  // swaps the page list for the pages that answer its question.
  | { type: "lens"; label: string; lens: BuiltinLens }
  // An operator value (S23): picking it writes `q` into the box, still open.
  | { type: "fill"; label: string; q: string };

// The chips under the box (S23): an operator to type a value for, then the
// No sources lens.
const CHIPS = [
  { op: "tag", labelKey: "cb_chip_tag" },
  { op: "path", labelKey: "cb_chip_folder" },
  { op: "type", labelKey: "cb_chip_type" },
] as const;
const CHIP_LABEL = { tag: "cb_chip_tag", path: "cb_chip_folder", type: "cb_chip_type" } as const;
const UNSOURCED = BUILTIN_LENSES.find((l) => l.key === "unsourced");

// A query to open the palette with (the sidebar's tag chips), taken on open.
let prefill: string | null = null;

/** Open ⌘K with `q` already in the box. */
export function openCommandBar(q: string): void {
  prefill = q;
  useUIStore.getState().setCmdOpen(true);
}

/** The recent rows by when their note last changed (UX S50): since local
 *  midnight, the seven days before, and the rest (no date counts as the
 *  rest, so rows never vanish while the dates load). Order kept. */
export function splitRecentByDay<T extends object>(
  rows: T[],
  mtimes: Map<string, number> | null,
  now: Date,
): { today: T[]; week: T[]; earlier: T[] } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  const weekAgo = midnight - 7 * 86400;
  const out = { today: [] as T[], week: [] as T[], earlier: [] as T[] };
  for (const row of rows) {
    const to = "to" in row && typeof row.to === "string" ? row.to : "";
    const at = mtimes?.get(to.slice(5)) ?? 0;
    (at >= midnight ? out.today : at >= weekAgo ? out.week : out.earlier).push(row);
  }
  return out;
}

export default function CommandBar({ t }: { t: Strings }): JSX.Element | null {
  const open = useUIStore((s) => s.cmdOpen);
  const setCmdOpen = useUIStore((s) => s.setCmdOpen);
  const setRoute = useUIStore((s) => s.setRoute);
  const route = useUIStore((s) => s.route);
  const navHistory = useUIStore((s) => s.navHistory);
  const fileTree = useVaultStore((s) => s.fileTree);
  const currentVault = useVaultStore((s) => s.currentVault);
  const adjacency = useVaultStore((s) => s.adjacency);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // The phone shell puts the box at the bottom, over the keyboard (UX S50).
  const phone = useMediaQuery(PHONE_QUERY);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [q, setQ] = useState("");
  // Hits for a "quoted phrase" — the substring scan run with the full phrase.
  const [exactHits, setExactHits] = useState<SearchHit[]>([]);
  const [contentHits, setContentHits] = useState<SearchHit[]>([]);
  // Semantic (embedding) hits — meaning matches even when the exact words differ.
  const [semanticHits, setSemanticHits] = useState<VecHit[]>([]);
  // The query whose exact / body / semantic arms have all answered.
  const [searched, setSearched] = useState<string | null>(null);
  // Index into the combined result list (filtered entries first, then
  // exactHits, contentHits, semanticHits). Keyboard arrows move it; Enter
  // activates the selected row.
  const [selected, setSelected] = useState(0);
  // ⌥⏎ logged the current query as a recall miss — swaps the footer hint.
  const [missLogged, setMissLogged] = useState(false);
  // Active lens; the box then filters its rows by name instead of the vault.
  const [lens, setLens] = useState<BuiltinLens | null>(null);
  // mtimes back the "recent" lens only — adjacency carries no dates.
  const [mtimes, setMtimes] = useState<Map<string, number> | null>(null);
  // Who committed each wiki/ page (S15): orders the rows and marks myco's.
  const [agentIndex, setAgentIndex] = useState<AuthorshipIndex>({});
  // A row closed the palette: it settles a pending "Quote in note" pick itself.
  const rowChosen = useRef(false);
  // What had focus when the palette opened. Every close (Escape, the overlay,
  // ⌘K, a row) hands focus back to it in the commit, so a modal a row opens
  // (Tidy, the New note prompt — mounted after this in App) takes it as its
  // opener and its Escape lands there too, not on <body>.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    returnFocus(opener.current);
    opener.current = null;
  }, [open]);

  useEffect(() => {
    // Focus at once too: keys are handled on the panel, so an Escape that beat
    // the deferred focus (a busy frame) reached the opener and the palette stayed.
    if (open) {
      if (prefill !== null) setQ(prefill);
      prefill = null;
      inputRef.current?.focus();
      setTimeout(() => inputRef.current?.focus(), 30);
    }
    if (!open) {
      // Closed with no row (Escape, the overlay, ⌘K again): nothing was picked.
      if (!rowChosen.current) cancelPickIntent();
      rowChosen.current = false;
      setQ("");
      setLens(null);
    }
  }, [open]);

  // The keyboard's height, as --kb-h on the overlay, so the bottom box rides
  // above it. A style write, not state: the input never re-renders (or loses
  // a Korean syllable mid-composition) when the keyboard resizes.
  useEffect(() => {
    if (!open || !phone) return;
    const vv = window.visualViewport;
    const update = (): void => {
      const { bottom } = sheetFrame(vv ?? null, window.innerHeight);
      overlayRef.current?.style.setProperty("--kb-h", `${bottom}px`);
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, [open, phone]);

  // Dates back the "recent" lens, and the phone's Today / 7 days groups.
  const wantMtimes = lens?.sort === "modified" || (open && phone);
  useEffect(() => {
    if (!wantMtimes || !currentVault) return;
    let cancelled = false;
    ipc.fileMtimes(currentVault.path).then(
      (pairs) => {
        if (!cancelled) setMtimes(new Map(pairs));
      },
      () => {
        // Without dates the lens degrades to name order rather than erroring.
        if (!cancelled) setMtimes(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wantMtimes, currentVault]);

  // Fetched per open: an agent write since the last open shows at once.
  useEffect(() => {
    if (!open || !currentVault) return;
    let cancelled = false;
    ipc.authorshipIndex(currentVault.path).then(
      (idx) => {
        if (!cancelled) setAgentIndex(idx);
      },
      // No history / lookup failure ⇒ {}: nothing is marked, all ranks as mine.
      () => {
        if (!cancelled) setAgentIndex({});
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, currentVault]);

  // Reset selection to the top whenever the query changes.
  useEffect(() => {
    setSelected(0);
    setMissLogged(false);
  }, [q]);

  // Full-text search across page contents, debounced. Names/routes are matched
  // locally above; this adds matches found inside the markdown bodies.
  useEffect(() => {
    const needle = q.trim();
    setSearched(null);
    // A lens already IS the result set; scanning the vault under it would
    // append pages the lens excluded.
    // An operator value being typed lists the vault's values instead.
    const { currentVault: vault, adjacency, fileTree } = useVaultStore.getState();
    if (
      needle.length < 2 ||
      lens ||
      operatorSuggestions(q, suggestSources(adjacency, fileTree, vault?.path ?? ""))
    ) {
      setExactHits([]);
      setContentHits([]);
      setSemanticHits([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      const parsed = parseSearchQuery(needle);
      const passes = (path: string): boolean =>
        hitPassesFilters(path, vault?.path ?? "", parsed, adjacency?.tags ?? {}, adjacency?.meta);
      const arms: Promise<void>[] = [];
      // Exact arm: the raw substring scan takes the whole quoted phrase as
      // its needle, so every hit contains it verbatim.
      const phrase = parsed.phrases[0];
      if (phrase) {
        arms.push(
          ipc
            .searchVault(phrase, 20)
            .then((hits) => {
              if (!cancelled) setExactHits(hits.filter((h) => passes(h.path)));
            })
            .catch(() => {
              if (!cancelled) setExactHits([]);
            }),
        );
      } else {
        setExactHits([]);
      }
      // Operator-only queries (e.g. just `path:wiki/`) leave nothing to scan.
      const lexQuery = parsed.terms || parsed.phrases.join(" ");
      if (!lexQuery) {
        setContentHits([]);
        setSemanticHits([]);
      } else {
        arms.push(
          ipc
            .searchVault(lexQuery, 20)
            .then((hits) => {
              if (!cancelled) setContentHits(hits.filter((h) => passes(h.path)));
            })
            .catch(() => {
              if (!cancelled) setContentHits([]);
            }),
          // Semantic hits run in parallel; empty when no index is built (quiet fail).
          ipc
            .semanticSearch(lexQuery, 6, "builtin-local", BUILTIN_EMBED_MODEL)
            .then((found) => {
              if (!cancelled) setSemanticHits(found.hits);
            })
            .catch(() => {
              if (!cancelled) setSemanticHits([]);
            }),
        );
      }
      // Every arm catches, so this always settles.
      void Promise.all(arms).then(() => {
        if (!cancelled) setSearched(needle);
      });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [q, lens]);

  // Human on record, unknown, myco's, then managed (S15) — name order within.
  const pages = useMemo(
    () =>
      byArea(
        collectFiles(fileTree),
        (n) => vaultRel(n.path, currentVault?.path ?? ""),
        agentIndex,
      ).map((n) => {
        const stem = n.name.replace(/\.md$/i, "");
        return {
          type: "page" as const,
          label: listedName(stem, adjacency?.meta?.[n.path]?.title),
          stem,
          to: `page:${n.path}` as RouteId,
        };
      }),
    [fileTree, adjacency, currentVault, agentIndex],
  );

  const groups = useMemo(() => {
    // Actions first: creating a note is the one thing the palette can DO
    // rather than merely navigate to.
    const actions: CmdEntry[] = [
      {
        type: "action",
        label: t.sb_new_note ?? "New note",
        run: () => promptNewNote(t),
      },
      {
        type: "action",
        label: t.tpl_new_from ?? "New note from template…",
        run: () => newNoteFromTemplate(t),
      },
    ];
    // Occasional tools: found by typing ("정리", "tidy"), never listed in the
    // empty box, which opens on what you were doing (backlog S2).
    const tools: CmdEntry[] = [
      {
        type: "action",
        label: t.tidy_cmd,
        run: async () => {
          useTidyStore.getState().setOpen(true);
          return null;
        },
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
      { type: "nav", label: t.nav_study, to: "study" },
      { type: "nav", label: t.nav_feedback ?? "Harvest box", to: "feedback" },
      { type: "nav", label: t.nav_settings, to: "settings" },
    ];
    // The Views page's lenses live here now — the route is gone (the owner's
    // vault held zero saved views), the questions it answered are not.
    const lenses: CmdEntry[] = BUILTIN_LENSES.map((lens) => ({
      type: "lens",
      label: t[lens.labelKey as keyof Strings] ?? lens.fallback,
      lens,
    }));
    return { actions, tools, navs, lenses };
  }, [t]);
  const all: CmdEntry[] = useMemo(
    () => [...groups.actions, ...groups.tools, ...groups.navs, ...groups.lenses, ...pages],
    [groups, pages],
  );
  // Notes opened lately, newest first; a deleted one drops out of the list.
  const recent: CmdEntry[] = useMemo(() => {
    const byRoute = new Map(pages.map((p) => [p.to, p]));
    return recentPages(navHistory, HISTORY_CAP)
      .flatMap((to) => byRoute.get(to) ?? [])
      .slice(0, 5);
  }, [navHistory, pages]);

  const sources = useMemo(
    () => suggestSources(adjacency, fileTree, currentVault?.path ?? ""),
    [adjacency, fileTree, currentVault],
  );

  // Rows of the active lens: runView over the wiki pages, exactly the table
  // the Views page used to draw.
  const lensRows = useMemo(() => {
    if (!lens || !adjacency) return [];
    const files = wikiPagesOnly(flattenMarkdown(fileTree), currentVault?.path);
    return runView(adjacency, files, lens.filter, lens.sort, lens.desc, mtimes ?? undefined).map(
      (r) => ({
        type: "page" as const,
        label: displayName(r.name),
        stem: r.name,
        to: `page:${r.path}` as RouteId,
      }),
    );
  }, [lens, adjacency, fileTree, currentVault, mtimes]);

  if (!open) return null;
  const suggest = lens ? null : operatorSuggestions(q, sources);
  // Operators (path: tag: type: status: confidence:) narrow the PAGE list by
  // frontmatter, so `type:concept` on its own lists the concept pages; any
  // free text left over matches names as before.
  const parsed = parseSearchQuery(q);
  const ops = hasOperators(parsed);
  // The vault's search returns my notes before the folders myco keeps
  // (vault.rs search_vault); this puts the human on record before the
  // unmarked and myco's pages, the vault's order within (S15).
  const relIn = (h: SearchHit): string => vaultRel(h.path, currentVault?.path ?? "");
  const exactRows = byArea(exactHits, relIn, agentIndex);
  const contentRows = byArea(contentHits, relIn, agentIndex);
  const needle = (ops ? parsed.terms : q).trim().toLowerCase();
  const base: CmdEntry[] = lens
    ? lensRows
    : ops
      ? pages.filter((p) =>
          hitPassesFilters(
            p.to.slice(5),
            currentVault?.path ?? "",
            parsed,
            adjacency?.tags ?? {},
            adjacency?.meta,
          ),
        )
      : all;
  // An empty box opens on what you were doing: labelled groups, the notes
  // you just had open among them. A typed query (or a lens / operators) is
  // one flat, capped list — a two-letter query over a 1121-file vault would
  // otherwise render every match into the palette.
  const sections: { label: string | null; rows: CmdEntry[] }[] = suggest
    ? [
        {
          label: t[CHIP_LABEL[suggest.op]],
          rows: suggest.values.map((v) => ({ type: "fill", label: v, q: `${suggest.head}${v} ` })),
        },
      ]
    : needle || lens || ops
      ? [
          {
            label: null,
            rows: needle
              ? base
                  .filter(
                    (x) =>
                      x.label.toLowerCase().includes(needle) ||
                      (x.type === "page" && x.stem?.toLowerCase().includes(needle)),
                  )
                  .slice(0, 50)
              : base.slice(0, 50),
          },
        ]
      : [
          { label: t.cb_group_actions, rows: groups.actions },
          ...(phone
            ? (() => {
                const by = splitRecentByDay(recent, mtimes, new Date());
                return [
                  { label: t.cb_group_today, rows: by.today },
                  { label: t.cb_group_week, rows: by.week },
                  { label: t.cb_group_recent, rows: by.earlier },
                ];
              })()
            : [{ label: t.cb_group_recent, rows: recent }]),
          { label: t.cb_group_goto, rows: groups.navs },
          { label: t.cb_group_lenses, rows: groups.lenses },
        ].filter((g) => g.rows.length > 0);
  const filtered = sections.flatMap((g) => g.rows);
  // A miss never dead-ends on "No results": the typed words can become a
  // note, or a question for the wiki. The rows come last, once every search
  // arm has answered — sooner, Enter would create a note the vault answers.
  const typed = missQuery(q, filtered.length, !!lens || ops || !!suggest);
  const miss: CmdEntry[] = [];
  if (typed && (q.trim().length < 2 || searched === q.trim())) {
    miss.push({
      type: "action",
      label: t.cb_create_q.replace("{q}", typed),
      run: () => createNoteAndOpen(typed),
    });
    // PageQuery reads the prefill on mount; from Ask itself nothing would.
    if (route !== "query")
      miss.push({
        type: "action",
        label: t.cb_ask_q.replace("{q}", typed),
        icon: "msg",
        run: async () => {
          setQueryPrefill(typed);
          setRoute("query");
          return null;
        },
      });
  }

  // The rendered groups form a single navigable list: nav/file entries first,
  // then exact-phrase hits, full-text content hits, semantic hits, the miss rows.
  const counts = {
    names: filtered.length,
    exact: exactHits.length,
    content: contentHits.length,
    semantic: semanticHits.length,
    miss: miss.length,
  };
  const exactBase = filtered.length;
  const contentBase = exactBase + exactHits.length;
  const semanticBase = contentBase + contentHits.length;
  const total = semanticBase + semanticHits.length;
  const rows = total + miss.length;
  const resultN = footCount(q, !!lens, counts);
  const active = rows > 0 ? Math.min(selected, rows - 1) : 0;

  function go(entry: CmdEntry): void {
    if (entry.type === "fill") {
      setQ(entry.q);
      inputRef.current?.focus();
      return;
    }
    if (entry.type === "lens") {
      // Stays open: the lens replaces the list and the box filters its rows.
      setLens(entry.lens);
      setQ("");
      inputRef.current?.focus();
      return;
    }
    rowChosen.current = true;
    setCmdOpen(false);
    // A pick waiting on the palette lands in the note this row opens — a new
    // note's dialog and create included — and is dropped by any other row.
    void settlePick(async () => {
      if (entry.type === "action") return entry.run();
      setRoute(entry.to);
      return entry.type === "page" ? entry.to : null;
    });
  }
  function goPath(path: string): void {
    rowChosen.current = true;
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
    const at = rowAt(index, counts);
    if (!at) return;
    if (at.list === "names") go(filtered[at.i]);
    else if (at.list === "exact") goPath(exactRows[at.i].path);
    else if (at.list === "content") goPath(contentRows[at.i].path);
    else if (at.list === "semantic") goIndexedPage(semanticHits[at.i].page);
    else go(miss[at.i]);
  }
  // Move the selection and scroll the newly-active row into view. Uses the
  // functional updater so rapid key-repeats (batched before a re-render) each
  // advance from the latest value instead of a stale closure.
  function move(delta: number): void {
    if (rows === 0) return;
    setSelected((prev) => (Math.min(prev, rows - 1) + delta + rows) % rows);
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
    // A chip takes its own Enter.
    if (e.key === "Enter" && e.target instanceof HTMLElement && e.target.closest(".cmd-chips"))
      return;
    if (e.key === "Escape") {
      setCmdOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Backspace" && lens && q === "") {
      // Backspace past an empty box drops the lens, like a chip in the input.
      setLens(null);
    } else if (e.key === "Enter" && e.altKey) {
      // ⌥⏎ — log the query to the recall-miss eval set (Q4 item 5).
      e.preventDefault();
      const vault = useVaultStore.getState().currentVault;
      if (vault && q.trim().length >= 2) {
        void ipc.recordRecallMiss(vault.path, q.trim()).catch(() => undefined);
        setMissLogged(true);
      }
    } else if (e.key === "Enter") {
      // The row closes the palette and focus returns to the opener within
      // this keydown: a textarea there would take the Enter as a newline.
      e.preventDefault();
      if (rows > 0) activate(active);
    } else if (e.key === "Tab") {
      // The rows are not tab stops (they are reached with the arrows): Tab
      // cycles the input and the chips, or it would walk focus onto the page
      // behind the modal while it stayed open.
      e.preventDefault();
      const stops = Array.from(
        e.currentTarget.querySelectorAll<HTMLElement>(".cmd-input input, .cmd-chip"),
      );
      const at = stops.indexOf(document.activeElement as HTMLElement);
      stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
    }
  }

  const listId = "cmd-listbox";
  const rowId = (i: number): string => `cmd-opt-${i}`;

  return (
    <div className="cmd-overlay" ref={overlayRef} onClick={() => setCmdOpen(false)}>
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
          {lens ? (
            <span className="cr-tag">{t[lens.labelKey as keyof Strings] ?? lens.fallback}</span>
          ) : null}
          <input
            ref={inputRef}
            placeholder={t.cb_placeholder}
            title={t.cb_operator_hint}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded={rows > 0}
            aria-controls={listId}
            // Without this the arrow selection is background-colour only —
            // a screen reader announces nothing as it moves.
            aria-activedescendant={rows > 0 ? rowId(active) : undefined}
            aria-autocomplete="list"
          />
        </div>
        {lens ? null : (
          <div className="cmd-chips" role="group" aria-label={t.cb_chips_label}>
            {CHIPS.map((c) => (
              <button
                key={c.op}
                type="button"
                className="pill cmd-chip"
                onClick={() => {
                  setQ(chipQuery(q, c.op));
                  inputRef.current?.focus();
                }}
              >
                {t[c.labelKey]}
              </button>
            ))}
            {UNSOURCED ? (
              <button
                type="button"
                className="pill cmd-chip"
                onClick={() => go({ type: "lens", label: "", lens: UNSOURCED })}
              >
                {t[UNSOURCED.labelKey as keyof Strings] ?? UNSOURCED.fallback}
              </button>
            ) : null}
          </div>
        )}
        <div className="cmd-list" id={listId} role="listbox" ref={listRef}>
          {filtered.length === 0 &&
          exactHits.length === 0 &&
          contentHits.length === 0 &&
          semanticHits.length === 0 ? (
            <div className="cmd-row muted">{t.cb_no_results ?? "No results"}</div>
          ) : null}
          {sections.map((g, gi) => {
            // Rows keep one index across groups: arrows and Enter walk them
            // as a single list.
            const start = sections.slice(0, gi).reduce((n, s) => n + s.rows.length, 0);
            return (
              <Fragment key={g.label ?? "rows"}>
                {g.label ? <div className="cmd-group-label">{g.label}</div> : null}
                {g.rows.map((r, j) => {
                  const i = start + j;
                  const folder =
                    r.type === "page"
                      ? pageNote(r.to.slice(5), currentVault?.path ?? "", agentIndex, t)
                      : "";
                  return (
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
                      {folder ? (
                        // Same-named notes in different folders are told apart here.
                        <span className="cmd-content-hit">
                          <span title={r.type === "page" ? r.stem : undefined}>{r.label}</span>
                          <span className="cmd-content-snippet cmd-path">{folder}</span>
                        </span>
                      ) : (
                        <span title={r.type === "page" ? r.stem : undefined}>{r.label}</span>
                      )}
                      <span className="cr-tag">
                        {r.type === "fill"
                          ? null
                          : r.type === "action"
                          ? (t.cb_tag_action ?? "action")
                          : r.type === "lens"
                            ? (t.cb_tag_lens ?? "lens")
                            : r.type === "nav"
                              ? (t.cb_tag_page ?? "page")
                              : /\.md$/i.test(r.to)
                                ? t.cb_tag_note
                                : (t.cb_tag_file ?? "file")}
                      </span>
                    </button>
                  );
                })}
              </Fragment>
            );
          })}
          {exactHits.length > 0 ? (
            <div className="cmd-group-label">
              {t.cb_exact ?? "Exact match"}
            </div>
          ) : null}
          {exactRows.map((h, i) => (
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
              <HitText hit={h} root={currentVault?.path ?? ""} index={agentIndex} t={t} />
              <span className="cr-tag">L{h.line}</span>
            </button>
          ))}
          {contentHits.length > 0 ? (
            <div className="cmd-group-label">
              {t.cb_in_contents ?? "In page contents"}
            </div>
          ) : null}
          {contentRows.map((h, i) => (
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
              <HitText hit={h} root={currentVault?.path ?? ""} index={agentIndex} t={t} />
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
                <span title={h.stem}>{displayName(h.stem)}</span>
                <span className="cr-tag">{(h.score * 100).toFixed(0)}%</span>
              </button>
            );
          })}
          {miss.length > 0 ? (
            <div className="cmd-group-label">{t.cb_group_actions}</div>
          ) : null}
          {miss.map((r, i) => {
            const idx = total + i;
            return (
              <button
                key={`miss-${r.label}`}
                id={rowId(idx)}
                role="option"
                aria-selected={active === idx}
                tabIndex={-1}
                className={`cmd-row${active === idx ? " active" : ""}`}
                onClick={() => go(r)}
              >
                <Icon name={iconFor(r)} size={13} />
                <span>{r.label}</span>
                <span className="cr-tag">{t.cb_tag_action ?? "action"}</span>
              </button>
            );
          })}
        </div>
        {/* Outside the scrolling list, so the keys stay in view. */}
        <div className="cmd-foot">
          <span className="kbd">↑↓</span>
          <span>
            <span className="kbd">↵</span> {t.cb_key_open}
          </span>
          {missLogged ? (
            <span>{t.cb_miss_done}</span>
          ) : (
            <span title={t.cb_miss_hint}>
              <span className="kbd">⌥↵</span> {t.cb_key_miss}
            </span>
          )}
          <span className="kbd">esc</span>
          {resultN !== null ? (
            <span className="cmd-foot__n">{t.cb_results_n.replace("{n}", String(resultN))}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function iconFor(entry: CmdEntry): IconName {
  if (entry.type === "action") return entry.icon ?? "plus";
  if (entry.type === "fill") return "search";
  if (entry.type === "lens") return "eye";
  if (entry.type === "page") return "page";
  if (entry.to === "overview") return "home";
  if (entry.to === "graph") return "graph";
  if (entry.to === "history") return "history";
  if (entry.to === "provenance") return "quote";
  if (entry.to === "ingest") return "upload";
  if (entry.to === "query") return "msg";
  if (entry.to === "study") return "sparkles";
  if (entry.to === "feedback") return "inbox";
  if (entry.to === "settings") return "settings";
  return "arrowR";
}

/** The words a typed query offers to Create / Ask with — when no name
 *  matched, or it reads as a question — else null. Never under a lens or
 *  operators (they filter), nor for a "quoted phrase": that is an exact
 *  search, and its quote marks would end up in the note's name. */
export function missQuery(q: string, nameHits: number, scoped: boolean): string | null {
  const parsed = parseSearchQuery(q);
  const s = parsed.terms;
  if (scoped || parsed.phrases.length > 0 || !s) return null;
  return nameHits === 0 || /[?？]$/.test(s) ? s : null;
}

type RowList = "names" | "exact" | "content" | "semantic" | "miss";

/** The footer's count: what the vault returned for a typed query or a lens,
 *  never the Create / Ask rows. Null for the empty box, whose actions and
 *  routes are not results. */
export function footCount(
  q: string,
  lens: boolean,
  counts: Record<RowList, number>,
): number | null {
  if (!q.trim() && !lens) return null;
  return counts.names + counts.exact + counts.content + counts.semantic;
}
const ROW_LISTS: readonly RowList[] = ["names", "exact", "content", "semantic", "miss"];

/** Which list the palette's combined row `index` falls in: the name rows, the
 *  exact / body / semantic hits, then the Create / Ask rows — last, so Enter
 *  (row 0) opens the top hit whenever there is one. Null past the end. */
export function rowAt(
  index: number,
  counts: Record<RowList, number>,
): { list: RowList; i: number } | null {
  let i = index;
  for (const list of ROW_LISTS) {
    if (i < counts[list]) return { list, i };
    i -= counts[list];
  }
  return null;
}

/** The line under a page row (S15): what a managed result is ("학습 카드")
 *  rather than its folder; else the folder, plus "myco가 씀" when the agent
 *  committed the page. No index row (no history) is unknown: no mark. */
export function pageNote(
  path: string,
  root: string,
  index: AuthorshipIndex,
  t: Strings,
): string {
  const rel = vaultRel(path, root);
  const kind = kindName(rel, t);
  if (kind) return kind;
  const folder = folderOf(path, root);
  return index[rel] === true ? [folder, t.sb_agent_mark].filter(Boolean).join(" · ") : folder;
}

/** An exact or body hit's text: its name, the line pageNote gives a name row
 *  (what a managed hit is, a page's folder, myco's mark — S15), the match. */
export function HitText({
  hit,
  root,
  index,
  t,
}: {
  hit: SearchHit;
  root: string;
  index: AuthorshipIndex;
  t: Strings;
}): JSX.Element {
  const stem = hit.name.replace(/\.md$/i, "");
  const note = pageNote(hit.path, root, index, t);
  return (
    <span className="cmd-content-hit">
      <span title={stem}>{displayName(stem)}</span>
      {note ? <span className="cmd-content-snippet cmd-path">{note}</span> : null}
      <span className="cmd-content-snippet">{hit.snippet}</span>
    </span>
  );
}

/** The box once a chip adds `op:` after what is typed. */
export function chipQuery(q: string, op: string): string {
  return `${q.trimEnd()} ${op}:`.trimStart();
}

/** Every folder in the tree, vault-relative, in name order. */
export function folderPaths(tree: FileNode[], root: string): string[] {
  const out: string[] = [];
  const stack = [...tree];
  while (stack.length) {
    const n = stack.pop();
    if (n?.kind !== "directory") continue;
    out.push(vaultRel(n.path, root));
    stack.push(...n.children);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function suggestSources(
  adjacency: Pick<Adjacency, "tags" | "meta"> | null,
  tree: FileNode[],
  root: string,
): SuggestSources {
  return { tags: adjacency?.tags ?? {}, meta: adjacency?.meta, folders: folderPaths(tree, root) };
}

/** Vault-relative folder of a note path ("" at the vault root). */
export function folderOf(path: string, root: string): string {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir === root) return "";
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir;
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
