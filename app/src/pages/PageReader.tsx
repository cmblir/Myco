// PageReader: opens a vault file via real IPC. A note opens in the one Live
// editor; the markdown source view lives in More (⋯). A raw/ file renders
// read-only through Viewer. The
// `sample/<id>` pseudo-route renders the design's mock content through Viewer.

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JSX } from "react";
import type { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "../lib/icons";
import type { Card } from "../lib/cards";
import type { Strings } from "../lib/i18n";
import { SAMPLE } from "../lib/sample";
import { useUIStore } from "../stores/uiStore";
import { getEditorRecoveryBaseline, pendingDrafts, useVaultStore } from "../stores/vaultStore";
import { useStudyStore } from "../stores/studyStore";
import { useAudioStore } from "../stores/audioStore";
import { cardsFromNote, clozeCardsFromQuote, clozePicks, isGrounded, isQuoted } from "../lib/extractiveCards";
import { addCards, deckPath, loadDeck, StudyDeckError } from "../lib/cardStore";
import { studyDeckMessage } from "../lib/studyDeckMessage";
import { pickCloze, previewCards, type ProposedCard } from "../components/CardPreview";
import { generateQuotedCards, modelStudyOn } from "../lib/study";
import { ipc } from "../lib/ipc";
import type { PageAuthorship } from "../lib/ipc";
import {
  badgeView,
  gutterRuns,
  parentParagraph,
  replaceLines,
  type GutterRun,
} from "../lib/authorship";
import { authorshipGutter } from "../lib/editorAuthorship";
import { claimCandidates, claimMarkers, type ClaimSpan } from "../lib/editorClaims";
import { retrieveChunks } from "../lib/chat";
import type { ScoredChunk } from "../lib/ipc";
import { stem } from "../lib/graphData";
import { openGraph } from "../lib/graphLink";
import { deleteNotes, moveNotes, renameNote } from "../lib/noteActions";
import { notice } from "../lib/notice";
import {
  getValue,
  parseFrontmatter,
  patchFrontmatter,
  type FmPatch,
  type Frontmatter,
} from "../lib/frontmatter";
import { listedName } from "../lib/displayName";
import { tagCandidates } from "../lib/tagIndex";
import { toggleCheckbox } from "../lib/taskLine";
import { stripFrontmatter } from "../lib/markdown";
import {
  bodyLineOffset,
  extractHeadings,
  type OutlineHeading,
} from "../lib/outline";
import {
  matchHeading,
  setPendingAnchor,
  takePendingAnchor,
} from "../lib/pendingAnchor";
import {
  blocksInRange,
  matchLines,
  takeReaderIntent,
  type ReaderIntent,
} from "../lib/askLoop";
import { FLASH_MS, flashField, flashLines } from "../lib/readerFlash";
import { useQueryStore } from "../stores/queryStore";
import Editor, { scrollEditorToLine } from "../components/Editor";
import ReaderRail, { ReaderRailSheet } from "../components/ReaderRail";
import ReaderRecovery, { type ReaderRecoveryFeedback, type ReaderRecoverySnapshot } from "../components/ReaderRecovery";
import AudioOverviewPanel from "../components/AudioOverviewPanel";
// Lazy — the pdf.js chunk is 437 kB and only a PDF source needs it. A markdown
// note mounts the viewer only once a [[pdf::…]] link opens one (see VaultPage).
const PdfViewer = lazy(() => import("../components/PdfViewer"));
import { usePdfStore } from "../stores/pdfStore";
import { parsePdfTarget, wikilinkBase } from "../lib/wikilinks";
import Viewer from "../components/Viewer";
import { Button, PHONE_QUERY, Sheet, useMediaQuery, useSheetMode } from "../components/ui";
import {
  captureToDaily,
  dailyDayOf,
  draftAfterCapture,
  openDailyNote,
  quoteBlocks,
  quoteLine,
  shiftDay,
  type Captured,
} from "../lib/dailyNote";
import { vaultRel } from "../lib/vaultAreas";
import type { LinkSuggestionIO } from "../lib/linkSuggestions";
import { insertionRange, railFoldsSidebar, railIsSheet } from "../lib/readerRail";
import {
  appendBlock,
  insertBlockTr,
  insertInlineTr,
} from "../lib/editorRecall";
import {
  useNoteInsertStore,
  type NoteInsert,
} from "../stores/noteInsertStore";

const AUTOSAVE_MS = 2000;

/** The words a reader selected in rendered prose: footnote markers ("[1]")
 *  are the renderer's, not the source's, and each block ends in a blank line
 *  (quoteBlocks splits there; quoteLine flattens it to a space).
 *  Bold and wikilinks are written back as markdown, so the quoted line keeps
 *  the terms a cloze card blanks (spec 2026-09-29 Part 1). */
function selectedProse(sel: Selection): string {
  const frag = sel.getRangeAt(0).cloneContents();
  frag.querySelectorAll(".footnote-ref").forEach((el) => el.remove());
  frag.querySelectorAll("strong, b").forEach((el) => el.replaceWith(`**${el.textContent ?? ""}**`));
  frag.querySelectorAll("a.myco-wikilink").forEach((el) => {
    const target = el.getAttribute("data-link") ?? "";
    const shown = el.textContent ?? "";
    el.replaceWith(target && target !== shown ? `[[${target}|${shown}]]` : `[[${shown}]]`);
  });
  frag
    .querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th")
    .forEach((el) => el.append("\n\n"));
  return frag.textContent ?? "";
}

export default function PageReader({
  t,
  pageRoute,
}: {
  t: Strings;
  pageRoute: string;
}): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  if (pageRoute.startsWith("sample/")) {
    const id = pageRoute.slice(7);
    const p = SAMPLE.pages.find((x) => x.id === id) ?? SAMPLE.pages[0];
    const md =
      SAMPLE.pageContents[id] ??
      `# ${p.title}\n\n_(Sample preview — open a real .md from the sidebar to edit.)_`;
    return (
      <div className="workspace">
        <div className="prose">
          <Viewer
            content={md}
            onLinkClick={(target) => setRoute(`page:sample/${target}`)}
          />
        </div>
      </div>
    );
  }
  if (/\.pdf$/i.test(pageRoute)) {
    return <PdfPage key={pageRoute} path={pageRoute} t={t} />;
  }
  return <VaultPage key={pageRoute} path={pageRoute} t={t} />;
}

// Opening a raw PDF directly (from the sidebar tree) shows the viewer full-width
// with no citing note. [[pdf::…]] link clicks inside a note open it with the
// note attached (see VaultPage).
function PdfPage({ path, t }: { path: string; t: Strings }): JSX.Element {
  const vaultPath = useVaultStore((s) => s.currentVault?.path);
  const openPdf = usePdfStore((s) => s.openPdf);
  useEffect(() => {
    if (!vaultPath) return;
    const relpath = path.startsWith(vaultPath + "/")
      ? path.slice(vaultPath.length + 1)
      : path;
    const stem = (path.split(/[\\/]/).pop() ?? path).replace(/\.pdf$/i, "");
    openPdf({ relpath, stem, citingNote: null }, 1);
  }, [path, vaultPath, openPdf]);
  return (
    <div className="workspace">
      <Suspense
        fallback={
          <p className="muted" style={{ padding: 16 }}>{t.pdf_loading ?? "Loading PDF…"}</p>
        }
      >
        <PdfViewer t={t} />
      </Suspense>
    </div>
  );
}

function VaultPage({ path, t }: { path: string; t: Strings }): JSX.Element {
  const openFile = useVaultStore((s) => s.openFile);
  const activeFile = useVaultStore((s) => s.activeFile);
  const adjacency = useVaultStore((s) => s.adjacency);
  const currentVaultPath = useVaultStore((s) => s.currentVault?.path);
  const vaultToken = useVaultStore((s) => s.vaultToken);
  const isOpeningVault = useVaultStore((s) => s.isOpeningVault);
  const genAudio = useAudioStore((s) => s.generate);
  const audioBusy = useAudioStore((s) => s.generating);
  // The overview panel mounts only while there is an overview (or an attempt)
  // to show — a dozen store subscriptions otherwise ran on every note.
  const audioActive = useAudioStore(
    (s) => s.generating || !!s.script || !!s.error,
  );
  const saveFile = useVaultStore((s) => s.saveFile);
  const openWikilink = useVaultStore((s) => s.openWikilink);
  const refreshTree = useVaultStore((s) => s.refreshTree);
  const toggleFavorite = useVaultStore((s) => s.toggleFavorite);
  const starred = useVaultStore(
    (s) => !!currentVaultPath && s.favorites.includes(path.slice(currentVaultPath.length + 1)),
  );
  const error = useVaultStore((s) => s.error);
  const pdfOpen = usePdfStore((s) => s.open !== null);
  const setRoute = useUIStore((s) => s.setRoute);
  const toggleCmd = useUIStore((s) => s.toggleCmd);
  const lang = useUIStore((s) => s.lang);
  const storedMode = useUIStore((s) => s.editorMode);
  const setMode = useUIStore((s) => s.setEditorMode);
  // The rail (properties · outline · sources · connections) reuses the
  // outline pane's per-device toggle — it is the same column.
  const railOpen = useUIStore((s) => s.outlineOpen);
  const toggleOutline = useUIStore((s) => s.toggleOutline);
  const foldSidebarForRail = useUIStore((s) => s.foldSidebarForRail);
  // Decided by this pane's width, not the window's: split beside Ask, the
  // note is 455px in a 1280px window. A body too narrow for both columns, or a
  // window under 960px, gets the rail as a sheet over the note. Opening the rail folds the sidebar only when the
  // width the fold gives this pane (all of the sidebar's, or a split pane's
  // share) puts the rail beside the note; closing it unfolds the sidebar again.
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  // The window alone decides the first frame, so a narrow window never flashes
  // the inline rail before the observer measures the body.
  const [railSheet, setRailSheet] = useState(() => railIsSheet(Infinity, window.innerWidth, remPx()));
  // The sheet is opened per visit, not stored: the stored rail preference
  // would otherwise put a modal over every note opened in a narrow window.
  // It is also forgotten when the rail switches between sheet and inline (a
  // resize, a split drag), so a sheet closed as the inline rail never returns.
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => setSheetOpen(false), [path, railSheet]);
  const railShown = railSheet ? sheetOpen : railOpen;
  const phone = useMediaQuery(PHONE_QUERY);
  useEffect(() => {
    if (!bodyEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setRailSheet(railIsSheet(e.contentRect.width, window.innerWidth, remPx())));
    ro.observe(bodyEl);
    return () => ro.disconnect();
  }, [bodyEl]);
  const toggleRail = (): void => {
    if (railSheet) {
      setSheetOpen((v) => !v);
      return;
    }
    if (!railOpen && bodyEl && !useUIStore.getState().sidebarCollapsed) {
      const pane = bodyEl.closest(".workspace-pane");
      const share = pane?.parentElement ? pane.clientWidth / pane.parentElement.clientWidth : 1;
      const side = document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0;
      if (railFoldsSidebar(bodyEl.clientWidth, side * share, remPx())) foldSidebarForRail();
    }
    toggleOutline();
  };
  // An Ask turn is active: the header offers the way back to it (A3) —
  // unless Ask is the other pane of a split, where the chip would replace
  // this note with the Ask already beside it.
  const askShown = useUIStore((s) => s.route === "query" || s.splitRoute === "query");
  const askActive = useQueryStore((s) => s.turns.length > 0) && !askShown;
  // Authorship badge (Q4 item 16). Null = no repo / untracked / lookup failed —
  // no history means no claim, so the header simply shows nothing.
  const [authorship, setAuthorship] = useState<PageAuthorship | null>(null);
  const [draft, setDraft] = useState("");
  // 0 until the first seed lands (no editor before then — it reads
  // initialValue once); bumped when a clean draft is re-seeded from disk so
  // the editor remounts on the new text.
  const [seedGen, setSeedGen] = useState(0);
  // The draft before Read-mode ticks (of seed `gen`), for the editor to
  // open on so ⌘Z takes them back; spent once an editor mounts.
  const [readBase, setReadBase] = useState<{ gen: number; text: string } | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryFeedback, setRecoveryFeedback] = useState<ReaderRecoveryFeedback | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const fm = useMemo(() => parseFrontmatter(draft), [draft]);
  const headings = useMemo(
    () => (railShown ? extractHeadings(stripFrontmatter(draft)) : []),
    [draft, railShown],
  );
  const lineOffset = useMemo(() => bodyLineOffset(draft), [draft]);
  // Keep writing free of per-line bars; attribution is an explicit review mode.
  // Local state resets on the next note, even when this note showed history.
  const [showAuthorship, setShowAuthorship] = useState(false);
  const paraRuns = useMemo(
    () => gutterRuns(authorship?.runs ?? [], draft),
    [authorship, draft],
  );
  const claims = useMemo(() => claimCandidates(draft), [draft]);
  const extras = useMemo(
    () => [
      flashField,
      authorshipGutter({
        runs: showAuthorship ? paraRuns : [],
        label: (r) =>
          `${r.agent ? (t.rd_auth_agent ?? "Written by the agent") : (t.rd_auth_human ?? "Written by you")} · ${fmtDate(r.ts, lang)}`,
        onSelect: (run, x, y) => setPick({ run, x, y }),
      }),
      claimMarkers({
        claims,
        label: t.rd_claim_dot ?? "This paragraph cites nothing",
        onSelect: (claim, x, y) => {
          setClaimHits(null);
          setClaimPick({ claim, x, y });
        },
      }),
    ],
    // Labels follow the language; the runs and claims follow the document.
    [showAuthorship, paraRuns, claims, lang, t],
  );
  // A paste error lasts until the next edit (a successful paste inserts text).
  useEffect(() => setEditorError(null), [draft]);
  const allTags = useMemo(
    () => tagCandidates(adjacency?.tags ?? {}, "", Infinity),
    [adjacency],
  );
  const isRaw =
    !!currentVaultPath && path.startsWith(`${currentVaultPath}/raw/`);
  // The backend preserves imported originals; offer the same read-only
  // behavior here instead of accepting edits that it will refuse to save.
  // "preview" is the read-only Viewer, which only a raw/ file opens in now.
  const mode = isRaw ? "preview" : storedMode;
  useEffect(() => {
    if (mode !== "preview") setReadBase(null);
  }, [mode]);
  // S41: the quote line for a selection in a raw/ original, and where the
  // selection ends on screen (the button sits under it). Null = no button.
  const [quoteAt, setQuoteAt] = useState<{ line: string; prose: string; x: number; y: number } | null>(
    null,
  );
  const [quoteBusy, setQuoteBusy] = useState(false);
  useEffect(() => {
    if (!isRaw) return;
    const follow = (): void => {
      const sel = window.getSelection();
      const root = previewRef.current;
      const prose =
        sel && !sel.isCollapsed && root?.contains(sel.anchorNode) && root.contains(sel.focusNode)
          ? selectedProse(sel)
          : "";
      const line = quoteLine(prose, path);
      if (!sel || !line) return setQuoteAt(null);
      const box = sel.getRangeAt(0).getBoundingClientRect();
      setQuoteAt({ line, prose, x: box.left + box.width / 2, y: box.bottom });
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") window.getSelection()?.removeAllRanges();
    };
    document.addEventListener("selectionchange", follow);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("selectionchange", follow);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [isRaw, path]);
  /** The selection goes into today's note through capture_note — the daily
   *  note is the only file written; the raw/ original is never touched. */
  // The last line quoted, so "Make a card" after "Quote" does not add it twice.
  const quotedRef = useRef<string | null>(null);
  async function quoteToDaily(line: string): Promise<boolean> {
    setQuoteBusy(true);
    // The raw/ original goes along so the note also gets its footnote definition.
    const source = currentVaultPath ? vaultRel(path, currentVaultPath) : undefined;
    const written = await captureToDaily(line, t, source);
    setQuoteBusy(false);
    if (written) {
      quotedRef.current = line;
      window.getSelection()?.removeAllRanges();
    }
    return written !== null;
  }
  const [cardBusy, setCardBusy] = useState(false);
  const [cardMsg, setCardMsg] = useState<string | null>(null);
  // Secondary editing and generation actions live in the overflow menu.
  const [moreOpen, setMoreOpen] = useState(false);
  // A phone width or a touch screen: the menu is a sheet, which keeps its own
  // focus, Escape and outside tap (useModalFocus), so the dropdown's own
  // handlers below stand down.
  const sheetMode = useSheetMode();
  const moreRef = useRef<HTMLDivElement | null>(null);
  function closeMore(): void {
    setMoreOpen(false);
    moreRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }
  // Authorship gutter: the paragraph whose bar was clicked, at the pointer.
  const [pick, setPick] = useState<{ run: GutterRun; x: number; y: number } | null>(null);
  // Uncited claim the amber dot was clicked on, and what the vault search
  // found for it ("loading" while it runs, null before it is asked).
  const [claimPick, setClaimPick] = useState<{ claim: ClaimSpan; x: number; y: number } | null>(
    null,
  );
  const [claimHits, setClaimHits] = useState<ScoredChunk[] | "loading" | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest text lets unmount flush the draft it still owns in pendingDrafts,
  // including undo to the disk baseline while an earlier save is in flight.
  const draftRef = useRef("");
  // The path we have already seeded the editor from. We seed ONCE per file —
  // reseeding on every activeFile change would let a self-initiated save (which
  // updates activeFile.raw) clobber keystrokes typed during that save.
  const seededPathRef = useRef<string | null>(null);
  // Last confirmed disk content for this reader. Only a clean draft may adopt
  // external edits; starting a write must not advance this baseline.
  const seededRawRef = useRef("");
  const mountedRef = useRef(true);
  const saveAttemptRef = useRef(0);
  const activeSavesRef = useRef(0);
  const draftGenerationRef = useRef(0);
  useEffect(() => {
    setRecoveryBusy(false);
    setRecoveryFeedback(null);
  }, [vaultToken]);

  // What this reader's own read said, not the store's shared error: an error
  // left by an earlier action must not read as "not found" before the read is
  // back, and a later save or favorite clearing it must not undo "not found".
  const [readFailure, setReadFailure] = useState<{
    path: string; vaultToken: string; error: string;
  } | null>(null);
  const readerRead = useRef<object | null>(null);
  // A failed read must keep recovery-only text out of save entry points.
  const readFailedRef = useRef(false);
  const readError = readFailure?.path === path && readFailure.vaultToken === vaultToken
    ? readFailure.error : null;
  const readCurrentFile = useCallback(async (): Promise<void> => {
    const vault = useVaultStore.getState();
    if (vault.vaultToken !== vaultToken || vault.isOpeningVault) return;
    const request = {};
    readerRead.current = request;
    const error = await openFile(path);
    if (readerRead.current !== request || useVaultStore.getState().vaultToken !== vaultToken || error === undefined) return;
    readFailedRef.current = error !== null;
    setReadFailure(error !== null ? { path, vaultToken, error } : null);
  }, [openFile, path, vaultToken]);
  // Wait for the native root, including same-root reopening: it resets the
  // cached file, and the new vault session must own both the read and its error.
  useEffect(() => {
    if (!currentVaultPath || isOpeningVault) return;
    void readCurrentFile();
    return () => { readerRead.current = null; };
  }, [readCurrentFile, currentVaultPath, isOpeningVault]);

  useEffect(() => {
    setAuthorship(null);
    if (!currentVaultPath) return;
    let cancelled = false;
    // Same rel derivation as PdfPage: the tree hands us absolute paths.
    const rel = path.startsWith(currentVaultPath + "/")
      ? path.slice(currentVaultPath.length + 1)
      : path;
    ipc.pageAuthorship(currentVaultPath, rel).then(
      (a) => {
        if (!cancelled) setAuthorship(a);
      },
      // A failed lookup renders the same as no history: no badge, no claim.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [path, currentVaultPath]);

  // The overflow menu closes on Escape or a click outside it, and moves focus
  // to its first item when opened so it is reachable without a pointer.
  useEffect(() => {
    if (!pick && !claimPick) return;
    const close = (): void => {
      setPick(null);
      setClaimPick(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement;
      if (!el.closest(".auth-pop, .cm-auth-gutter, .cm-claim-gutter")) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [pick, claimPick]);

  useEffect(() => {
    if (!moreOpen || sheetMode) return;
    moreRef.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMore();
      }
      if (!moreRef.current?.contains(e.target as Node)) return;
      const items = [...moreRef.current.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (current + 1) % items.length
        : e.key === "ArrowUp" ? (current - 1 + items.length) % items.length
        : e.key === "Home" ? 0
        : e.key === "End" ? items.length - 1 : null;
      if (next !== null) {
        e.preventDefault();
        items[next].focus();
      }
    };
    const onDown = (e: MouseEvent): void => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [moreOpen, sheetMode]);

  useEffect(() => {
    if (activeFile?.path !== path) return;
    if (seededPathRef.current !== path) {
      seededPathRef.current = path;
      // Seed from `raw` (the full file incl. frontmatter), not the stripped
      // `content`, so editing + autosave round-trips the frontmatter losslessly.
      const restored = pendingDrafts.get(path);
      setDraft(restored ?? activeFile.raw);
      draftRef.current = restored ?? activeFile.raw;
      // A recovered draft keeps its first full read, not the newer disk text.
      seededRawRef.current = restored !== undefined
        ? getEditorRecoveryBaseline(path) ?? activeFile.raw : activeFile.raw;
      // Even an undo back to the disk text can have an unconfirmed write.
      // This reader has no timer for a restored draft, so offer a retry.
      setSaveFailed(restored !== undefined);
      setSeedGen((g) => g + 1);
    } else if (activeFile.raw === draftRef.current && !pendingDrafts.has(path)) {
      // A save started by the previous reader may finish after we re-opened.
      seededRawRef.current = activeFile.raw;
      setSaveFailed(false);
    } else if (
      activeFile.raw !== seededRawRef.current &&
      draftRef.current === seededRawRef.current &&
      !pendingDrafts.has(path)
    ) {
      // Another surface (Views bulk edit, a move) rewrote this note while the
      // draft is clean: adopt it. ponytail: a dirty draft is left alone — its
      // pending autosave wins. A successful save updates the baseline without
      // re-seeding the editor, so newer typing and undo stay intact.
      const raw = activeFile.raw;
      setDraft(raw);
      draftRef.current = raw;
      seededRawRef.current = raw;
      setSeedGen((g) => g + 1);
    }
    // The object, not just `raw`: a confirmed write of the text already on
    // disk (an undo, flushed by the reader a closed split unmounted) changes
    // no `raw`, yet must clear the retry banner the restored draft raised.
  }, [activeFile, path]);

  // `[[Note#Heading]]`: once this note's draft is seeded, scroll to the anchor
  // the link recorded. Keyed on seedGen (not draft) so typing never re-scrolls;
  // take() consumes the anchor, so later re-seeds find nothing.
  useEffect(() => {
    if (seedGen === 0) return;
    // Both are consumed after effects settle, as the editor's own writing
    // request is: StrictMode's first pass destroys the view this ran against
    // (the anchor was spent on it and Live opened at the top), and the
    // cleanup cancels the frame without losing either.
    const frame = requestAnimationFrame(() => {
      const anchor = takePendingAnchor(path);
      if (anchor) scrollToAnchor(anchor);
      // Ask's "Quote in note" with no note beside it: the block goes to this
      // note's end (undoable, autosaved like any edit) and the end comes into
      // view. Never a raw/ file — the intent is dropped, as the insert store is.
      const intent = takeReaderIntent(path);
      if (intent?.kind === "append" && !isRaw) {
        applyDocEdit(appendBlock(draftRef.current, intent.block));
        const v = editorViewRef.current;
        if (v) scrollEditorToLine(v, v.state.doc.lines);
        else previewRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
      }
      if (intent?.kind === "show") showPassage(intent);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, seedGen]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // Flush unsaved edits on navigation/unmount regardless of the timer state.
      // Map ownership survives failed writes and undo to an earlier baseline.
      // A rename/deletion removes ownership so this reader cannot recreate the
      // old path; another reader's newer draft must also remain untouched.
      if (!readFailedRef.current && pendingDrafts.get(path) === draftRef.current) {
        void saveFile(path, draftRef.current);
      }
    };
  }, [path, saveFile]);

  async function persistDraft(c: string): Promise<void> {
    if (readFailedRef.current) return;
    const attempt = ++saveAttemptRef.current;
    activeSavesRef.current += 1;
    if (mountedRef.current) setIsSaving(true);
    const saved = await saveFile(path, c);
    if (saved) seededRawRef.current = c;
    activeSavesRef.current -= 1;
    if (!mountedRef.current) return;
    setIsSaving(activeSavesRef.current > 0);
    if (attempt === saveAttemptRef.current) setSaveFailed(!saved);
  }

  function scheduleSave(c: string): void {
    if (readFailedRef.current) return;
    draftGenerationRef.current += 1;
    setRecoveryFeedback(null);
    draftRef.current = c;
    pendingDrafts.set(path, c);
    void useVaultStore.getState().persistPendingEditorDraft(path, c);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      // A rename or deletion can consume this timer's draft before it fires.
      if (pendingDrafts.get(path) === c) void persistDraft(c);
    }, AUTOSAVE_MS);
  }
  async function flushSave(c: string): Promise<void> {
    if (pendingDrafts.get(path) !== c) return;
    draftRef.current = c;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await persistDraft(c);
  }

  function captureRecovery(): ReaderRecoverySnapshot | null {
    const vault = useVaultStore.getState();
    const ui = useUIStore.getState();
    const noteRoute = `page:${path}`;
    if (!mountedRef.current || vault.isOpeningVault || vault.vaultToken !== vaultToken ||
      !currentVaultPath || vault.currentVault?.path !== currentVaultPath || activeSavesRef.current > 0 ||
      [ui.route, ui.splitRoute].filter((route) => route === noteRoute).length !== 1) return null;
    const visit = readerRead.current;
    const generation = draftGenerationRef.current;
    const saveAttempt = saveAttemptRef.current;
    const expectedDraft = pendingDrafts.get(path);
    const draftVersion = pendingDrafts.version(path);
    const originalBaseline = getEditorRecoveryBaseline(path);
    const text = expectedDraft ?? (readError === null
      ? seededPathRef.current === path ? draftRef.current :
        vault.activeFile?.path === path ? vault.activeFile.raw : undefined
      : undefined);
    const ownsView = (): boolean => {
      const current = useVaultStore.getState();
      const presentation = useUIStore.getState();
      return mountedRef.current && !current.isOpeningVault && current.vaultToken === vaultToken &&
        current.currentVault?.path === currentVaultPath && readerRead.current === visit &&
        draftGenerationRef.current === generation && saveAttemptRef.current === saveAttempt && activeSavesRef.current === 0 &&
        presentation.route === ui.route && presentation.splitRoute === ui.splitRoute && presentation.navHistory === ui.navHistory;
    };
    return {
      path, draft: expectedDraft, text, originalBaseline,
      isCurrent: () => ownsView() && useVaultStore.getState().activeFile === vault.activeFile &&
        pendingDrafts.get(path) === expectedDraft && pendingDrafts.version(path) === draftVersion &&
        getEditorRecoveryBaseline(path) === originalBaseline,
      prepare: () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      },
      adopt: (file) => {
        // The store has consumed this draft; validate the view without treating
        // that successful transition as a foreign Map mutation.
        if (!ownsView() || file.path !== path || useVaultStore.getState().activeFile !== file || pendingDrafts.has(path)) return false;
        draftGenerationRef.current += 1;
        draftRef.current = file.raw;
        seededRawRef.current = file.raw;
        seededPathRef.current = path;
        setDraft(file.raw);
        setReadBase(null);
        readFailedRef.current = false;
        setReadFailure(null);
        setSaveFailed(false);
        setEditorError(null);
        setSeedGen((gen) => gen + 1);
        return true;
      },
    };
  }

  /** Apply a whole-document rewrite as its ONE changed range, so the caret,
   *  the scroll position and undo survive an append from the rail. */
  function applyDocEdit(next: string): void {
    const range = insertionRange(draftRef.current, next);
    if (!range) return;
    const v = editorViewRef.current;
    if (v) {
      v.dispatch({ changes: range }); // updateListener → onChange → autosave
    } else {
      setDraft(next);
      scheduleSave(next);
    }
  }

  // "Insert at cursor" from the rail, resurfaced notes and Ask (split pane):
  // one transaction at the editor's caret, so caret and undo are kept; with
  // no editor (Preview) the block goes to the note's end via applyDocEdit.
  // Never a raw/ file (immutable). Reads refs only, so registering once per
  // opened note is enough.
  const seeded = seedGen > 0;
  useEffect(() => {
    if (isRaw || !seeded) return;
    const insert: NoteInsert = (text, block) => {
      const v = editorViewRef.current;
      if (!v) return applyDocEdit(appendBlock(draftRef.current, text));
      const { state } = v;
      v.dispatch(
        block
          ? insertBlockTr(state, state.selection.main.head, text)
          : insertInlineTr(state, text),
      );
      v.focus();
    };
    useNoteInsertStore.setState({ insert });
    return () => {
      if (useNoteInsertStore.getState().insert === insert)
        useNoteInsertStore.setState({ insert: null });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRaw, seeded]);

  // Home's ⌘Enter and the notch append to today's note on disk. This reader
  // takes the line — a clean draft re-reads the file, a dirty one appends it —
  // or its next autosave writes the stale buffer over the capture.
  useEffect(() => {
    if (isRaw || !seeded || !currentVaultPath) return;
    let live = true;
    const off = listen<Captured>("myco://daily-captured", ({ payload }) => {
      if (!live) return;
      if (`${currentVaultPath}/${payload.rel}` !== path) return;
      const dirty = draftRef.current !== seededRawRef.current || pendingDrafts.has(path);
      const next = draftAfterCapture(draftRef.current, dirty, payload.line, payload.footnote);
      if (next === null) void readCurrentFile();
      else applyDocEdit(next);
    }).catch(() => null); // plain-browser dev: no Tauri event bus
    return () => {
      live = false;
      void off.then((unlisten) => unlisten?.());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRaw, seeded, currentVaultPath, path, readCurrentFile]);

  // Accepting a suggested link edits the OPEN draft, not the file on disk: a
  // disk write would be overwritten by the next autosave of the stale buffer.
  // `appendWikilink` (the same helper acceptSuggestion uses) still decides
  // where the link goes — under `## Related`, created if absent.
  const railIo: LinkSuggestionIO = {
    readFile: () => Promise.resolve({ raw: draftRef.current }),
    transformFile: (_path, transform) => {
      applyDocEdit(transform(draftRef.current));
      return Promise.resolve(null);
    },
    writeFile: (_path, content) => {
      applyDocEdit(content);
      return Promise.resolve(null);
    },
  };

  /** Put one agent paragraph back the way the parent of its commit had it.
   *  Reads that revision through the history IPC — no local copy of history —
   *  and replaces only this paragraph's lines; the normal autosave saves it. */
  async function revertParagraph(run: GutterRun): Promise<void> {
    setPick(null);
    if (!currentVaultPath) return;
    const rel = path.startsWith(currentVaultPath + "/")
      ? path.slice(currentVaultPath.length + 1)
      : path;
    const parent = await ipc
      .pageAtRevision(currentVaultPath, rel, `${run.sha}^`)
      .catch(() => undefined);
    if (parent === undefined) {
      notice.warn(t.rd_auth_failed ?? "That revision could not be read.");
      return;
    }
    // No file in the parent tree: the commit created it, so the paragraph is
    // new and reverting means removing it.
    const restored = parent ? parentParagraph(draftRef.current, parent, run.from, run.to) : "";
    if (restored === null) {
      notice.warn(
        t.rd_auth_nothing ?? "The earlier revision already holds this paragraph.",
        {
          action: {
            label: t.rd_auth_history ?? "See it in history",
            run: () => setRoute("history"),
          },
        },
      );
      return;
    }
    applyDocEdit(replaceLines(draftRef.current, run.from, run.to, restored));
    notice.ok(t.rd_auth_reverted ?? "Paragraph reverted");
  }

  /** "Find a source": the paragraph becomes the query for the same wiki
   *  retrieval Ask uses. Nothing is inserted without a click on a result. */
  async function findSources(claim: ClaimSpan): Promise<void> {
    setClaimHits("loading");
    const r = await retrieveChunks(claim.text, 3, undefined, undefined, "wiki").catch(
      () => null,
    );
    setClaimHits(r ? r.hits.slice(0, 3) : []);
  }

  /** Point the claim at a page: `[[stem]]` on the paragraph's last line. */
  function citeClaim(claim: ClaimSpan, page: string): void {
    const lines = draftRef.current.split("\n");
    const i = claim.to - 1;
    const name = stem(page);
    if (i < 0 || i >= lines.length || lines[i].includes(`[[${name}]]`)) return;
    lines[i] = lines[i].replace(/\s*$/, ` [[${name}]]`);
    applyDocEdit(lines.join("\n"));
    setClaimPick(null);
    notice.ok((t.rd_claim_added ?? "Cited [[{name}]]").replace("{name}", name));
  }

  /** A to-do box ticked in Read: flip `[ ]`/`[x]` on its line in the draft
   *  (one edit, autosaved like any); nothing when the line moved on. */
  function toggleTask(bodyLine: number): void {
    const next = toggleCheckbox(
      draftRef.current,
      bodyLine + 1 + bodyLineOffset(draftRef.current),
    );
    if (next === null) return;
    const text = draftRef.current;
    setReadBase((b) => (b?.gen === seedGen ? b : { gen: seedGen, text }));
    applyDocEdit(next);
  }

  function patchProps(patch: FmPatch): void {
    const edit = patchFrontmatter(draftRef.current, patch);
    const v = editorViewRef.current;
    // One transaction over the frontmatter range keeps cursor/scroll, makes
    // ⌘Z undo the property edit, and reaches autosave via updateListener →
    // onChange. Without an editor (Preview) patch the draft directly.
    if (v) {
      v.dispatch({
        changes: {
          from: 0,
          to: Math.min(edit.to, v.state.doc.length),
          insert: edit.insert,
        },
      });
    } else {
      setDraft(edit.raw);
      scheduleSave(edit.raw);
    }
  }

  // Scroll the pane the current mode shows: the editor by line (body line +
  // frontmatter lines), the preview by the heading's data-line.
  function scrollToHeading(h: Pick<OutlineHeading, "line">): void {
    const v = editorViewRef.current;
    if (v) scrollEditorToLine(v, h.line + 1 + lineOffset);
    else {
      // The page's own heading: an embedded section's headings carry the
      // other note's line numbers.
      const el = previewRef.current?.querySelector(
        `[data-line="${h.line}"]:not(.md-embed-body *)`,
      );
      // A heading in a folded toggle (<details>) opens its toggles first.
      previewRef.current?.querySelectorAll("details").forEach((d) => {
        if (el && d.contains(el)) d.open = true;
      });
      el?.scrollIntoView({ block: "start" });
      // Focus follows, as the editor's does (and a footnote link's, Viewer):
      // the next Tab goes on from the heading, not from the link. After the
      // toggles open: nothing in a closed <details> takes focus.
      if (el instanceof HTMLElement) {
        if (!el.matches("a[href], button, input, select, textarea, [tabindex]"))
          el.setAttribute("tabindex", "-1");
        el.focus({ preventScroll: true });
      }
    }
  }

  // Anchor not found → nothing happens (Obsidian does the same, no error UI).
  function scrollToAnchor(anchor: string): OutlineHeading | undefined {
    const h = matchHeading(
      extractHeadings(stripFrontmatter(draftRef.current)),
      anchor,
    );
    if (h) scrollToHeading(h);
    return h;
  }

  // A citation opened this note (Ask, UX audit A3): the quoted lines come
  // into view and flash — Live's lines, Preview's blocks (each carries its
  // body line, Viewer sourceLines). A passage the note no longer holds
  // falls back to its section's heading.
  function showPassage({ section, quote }: Extract<ReaderIntent, { kind: "show" }>): void {
    const v = editorViewRef.current;
    const lines = matchLines(draftRef.current, quote);
    if (v && lines) {
      scrollEditorToLine(v, lines.from);
      flashLines(v, lines.from, lines.to);
      return;
    }
    const root = previewRef.current;
    let lit: HTMLElement[] = [];
    if (root && lines) {
      const blocks = [
        ...root.querySelectorAll<HTMLElement>("[data-line]:not(.md-embed-body *)"),
      ];
      const body = 1 + bodyLineOffset(draftRef.current); // 1-based doc → body line
      lit = blocksInRange(
        blocks.map((el) => Number(el.dataset.line)),
        lines.from - body,
        lines.to - body,
      ).map((i) => blocks[i]);
      // The innermost blocks: a list lit whole would light items past the passage.
      lit = lit.filter((el) => !lit.some((o) => o !== el && el.contains(o)));
      // A passage in a folded toggle (<details>) opens it, as scrollToHeading does.
      root.querySelectorAll("details").forEach((d) => {
        if (lit.some((el) => d.contains(el))) d.open = true;
      });
      lit[0]?.scrollIntoView({ block: "start" });
    }
    if (!lit.length && section) {
      const h = scrollToAnchor(section);
      const head = h && root?.querySelector<HTMLElement>(`[data-line="${h.line}"]:not(.md-embed-body *)`);
      if (head) lit = [head];
    }
    lit.forEach((el) => el.classList.add("ask-flash"));
    window.setTimeout(() => lit.forEach((el) => el.classList.remove("ask-flash")), FLASH_MS);
  }

  function handleLinkClick(target: string, line?: number): void {
    // Pinpoint PDF link → open the viewer at the page/anchor.
    const pdf = parsePdfTarget(target);
    if (pdf && currentVaultPath) {
      usePdfStore.getState().openPdf(
        {
          relpath: `raw/${pdf.stem}.pdf`,
          stem: pdf.stem,
          citingNote: path,
        },
        pdf.page,
        pdf.anchorId,
      );
      return;
    }
    // Resolve, or create the note next to the current file and open
    // it (Obsidian-style create-on-click) — same as Ask and the
    // agent panel, via the shared store method.
    const base = wikilinkBase(target);
    const hash = target.indexOf("#");
    const anchor = hash < 0 ? "" : target.slice(hash + 1).trim();
    // `[[#Heading]]` and `[[ThisNote#Heading]]` stay on this page: the seed
    // effect will not re-run, so scroll right away. A TOC row names its
    // heading's line: a repeated heading name goes to its own.
    if (!base) {
      if (line !== undefined) scrollToHeading({ line });
      else if (anchor) scrollToAnchor(anchor);
      return;
    }
    const dir = path.replace(/[\\/][^\\/]+$/, "");
    void openWikilink(base, dir).then((p) => {
      if (!p) return;
      if (p === path) {
        if (anchor) scrollToAnchor(anchor);
        return;
      }
      if (anchor) setPendingAnchor(p, anchor);
      setRoute(`page:${p}`);
    });
  }

  async function makeCards(): Promise<void> {
    if (!currentVaultPath || !activeFile || cardBusy) return;
    // One deck per note, named after it: cards/<stem>.md says where a card
    // came from (resolveWikilink skips cards/, so the name never collides).
    const deck = (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, "");
    setCardBusy(true);
    setCardMsg(null);
    try {
      // The note's own words, as the editor holds them now — no model call.
      const note = draft || activeFile.raw;
      const proposed: ProposedCard[] = cardsFromNote(note, deck, t).map((card) => ({ card }));
      // Opt-in (Settings → Study): a connected model drafts more, each one
      // kept only if its answer is quoted from the note.
      if (await modelStudyOn(useUIStore.getState().aiCards)) {
        try {
          const drafted = await generateQuotedCards(currentVaultPath, note, deck);
          proposed.push(...drafted.map((card) => ({ card, ai: true })));
        } catch (err) {
          notice.warn(t.rd_cards_ai_failed, { sub: String(err) });
        }
      }
      if (proposed.length === 0) {
        setCardMsg(t.rd_cards_none);
        return;
      }
      await previewAndSave(currentVaultPath, deck, (existing, deckFile) =>
        previewCards(t, proposed, existing, deckFile),
      );
    } catch (err) {
      setCardMsg(err instanceof StudyDeckError ? studyDeckMessage(err, t) : String(err));
    } finally {
      setCardBusy(false);
    }
  }

  /** A preview sheet (`choose`), then the picked cards into cards/<deck>.md.
   *  `beforeSave` runs once something is picked; false there saves nothing. */
  async function previewAndSave(
    vault: string,
    deck: string,
    choose: (existing: Card[], deckFile: string) => Promise<Card[] | "none" | null>,
    beforeSave?: () => Promise<boolean>,
  ): Promise<void> {
    const deckFile = `cards/${deck}.md`;
    const existing = await loadDeck(deckPath(vault, deck)).catch(() => []);
    const cards = await choose(existing, deckFile);
    if (cards === "none") {
      setCardMsg(t.rd_cards_none_picked);
      return;
    }
    if (!cards) return;
    if (cards.length === 0) {
      setCardMsg(t.rd_cards_all_dupes.replace("{deck}", deckFile));
      return;
    }
    if (beforeSave && !(await beforeSave())) return;
    const { added } = await addCards(vault, deck, cards);
    await refreshTree();
    await useStudyStore.getState().refresh();
    setCardMsg(
      (t.rd_cards_made ?? "{n} cards added").replace("{n}", String(added)),
    );
  }

  /** S41: cloze cards from a selection in a raw/ original. The line goes into
   *  today's note too (unless it already went), so each card is grounded by a
   *  vault note citing the original; the deck is cards/<original's stem>.md. */
  async function makeQuoteCard(line: string, prose: string): Promise<void> {
    if (!currentVaultPath || cardBusy) return;
    // Per block, so a cloze stays one source sentence; a card past the cut of
    // a long line would quote words today's note never got, so it is dropped.
    const blocks = quoteBlocks(prose, path);
    const proposed = blocks
      .flatMap(clozeCardsFromQuote)
      .filter((card) => isGrounded(card, line))
      .map((card) => ({ card }));
    // Default 9: no bold or wikilinked term to blank, so the owner picks the
    // word; only sentences today's note will hold, as above.
    const picks =
      proposed.length > 0
        ? []
        : blocks.flatMap(clozePicks).filter((p) => isQuoted(p.sentence, line));
    if (proposed.length === 0 && picks.length === 0) {
      setCardMsg(t.rd_quote_card_none);
      return;
    }
    setCardBusy(true);
    setCardMsg(null);
    try {
      const sheet = {
        ...t,
        rd_cards_preview_title: t.rd_quote_card_title,
        rd_cards_preview_msg: t.rd_quote_card_msg,
      };
      await previewAndSave(
        currentVaultPath,
        stem(path),
        (existing, deckFile) =>
          picks.length > 0
            ? pickCloze(t, picks, existing, deckFile)
            : previewCards(sheet, proposed, existing, deckFile),
        () => (quotedRef.current === line ? Promise.resolve(true) : quoteToDaily(line)),
      );
    } catch (err) {
      setCardMsg(String(err));
    } finally {
      setCardBusy(false);
    }
  }

  function makeAudio(): void {
    if (!currentVaultPath || audioBusy) return;
    const stem = (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, "");
    // This page + its immediate wikilink neighbours (out + in), deduped.
    const neighbours = [
      ...(adjacency?.forward[path] ?? []),
      ...(adjacency?.backward[path] ?? []),
    ];
    const pages = [path, ...neighbours].filter(
      (p, i, arr) => arr.indexOf(p) === i,
    ).slice(0, 8);
    void genAudio(stem, pages);
  }

  const view = readerView(activeFile?.path, path, readError);
  const recoveryControls = (
    <ReaderRecovery
      key={vaultToken}
      t={t}
      visible={saveFailed || readError !== null}
      readOnly={isRaw || readError !== null}
      canCopy={!isSaving && (pendingDrafts.has(path) || getEditorRecoveryBaseline(path) !== undefined ||
        (readError === null && (seededPathRef.current === path || activeFile?.path === path)))}
      originalBaseline={getEditorRecoveryBaseline(path)}
      currentFile={readError === null && activeFile?.path === path ? activeFile.raw : undefined}
      recoveryDraft={readError !== null ? pendingDrafts.get(path) : undefined}
      onRetryRead={readError !== null ? readCurrentFile : undefined}
      capture={captureRecovery}
      onBusyChange={(busy) => {
        if (mountedRef.current && useVaultStore.getState().vaultToken === vaultToken) setRecoveryBusy(busy);
      }}
      onFeedback={(feedback) => {
        if (mountedRef.current && useVaultStore.getState().vaultToken === vaultToken) setRecoveryFeedback(feedback);
      }}
    />
  );
  const recoveryMessage = recoveryFeedback ? (
    <p className="reader-recovery-message" role={recoveryFeedback.error ? "alert" : "status"}>
      {recoveryFeedback.message}
    </p>
  ) : null;
  if (view !== "ready" || !activeFile) {
    return (
      <div className="workspace">
        {view === "missing" || view === "unreadable" ? (
          <div className="rd-missing" role="alert">
            <h1 className="page-title" tabIndex={-1}>
              {view === "missing" ? t.rd_not_found : t.rd_unreadable}
            </h1>
            <p className="muted">{view === "missing" ? t.rd_not_found_sub : readError}</p>
            <p className="rd-missing__path" title={readError ?? undefined}>
              {currentVaultPath && path.startsWith(`${currentVaultPath}/`)
                ? path.slice(currentVaultPath.length + 1)
                : path}
            </p>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <Button onClick={toggleCmd} title="⌘K">
                <Icon name="search" size={14} /> {t.rd_find_note}
              </Button>
              <Button variant="quiet" onClick={() => setRoute("overview")}>
                <Icon name="home" size={14} /> {t.rd_go_home}
              </Button>
            </div>
            {recoveryControls}
            {recoveryMessage}
          </div>
        ) : (
          <div className="rd-skeleton" role="status" aria-busy="true" aria-label={t.rd_loading}>
            <span className="rd-skeleton__title" />
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    );
  }

  const fileName = path.split(/[\\/]/).pop() ?? path;
  const noteTitle = listedName(fileName.replace(/\.md$/i, ""), fmString(fm, "title"));
  const noteType = fmString(fm, "type");
  const dailyDay = currentVaultPath ? dailyDayOf(path, currentVaultPath) : null;
  const badge = authorship
    ? badgeView(authorship, Math.floor(Date.now() / 1000), lang)
    : null;
  const saveStatus = isSaving ? "saving"
    : saveFailed ? "failed"
    : pendingDrafts.has(path) || draft !== activeFile.raw ? "pending"
    : "saved";
  const saveLabel = saveStatus === "saving" ? t.rd_saving
    : saveStatus === "failed" ? t.rd_not_saved
    : saveStatus === "pending" ? t.rd_save_pending
    : t.rd_saved;
  const rail = (
    <ReaderRail
      filePath={path}
      fm={fm}
      allTags={allTags}
      onPatch={patchProps}
      headings={headings}
      onSelectHeading={scrollToHeading}
      io={railIo}
      readOnly={isRaw}
      authorship={badge}
      t={t}
    />
  );
  // Ask over this note and its one-hop links (UX S37). Ask already open
  // beside the note takes the scope in place.
  const askThisNote = (): void => {
    useQueryStore.getState().setNoteScope({ path, title: noteTitle });
    if (useUIStore.getState().splitRoute !== "query") setRoute("query");
  };
  // The overflow menu's items: a dropdown under ···, or a sheet from the
  // bottom on a phone width or a touch screen (UX S49).
  const moreMenu = (
    <div className="rd-menu" role="menu" aria-label={t.rd_more}>
      {phone ? (
        // A phone folds the action line into this menu (UX S54).
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMore();
              toggleRail();
            }}
          >
            <Icon name="columns" size={13} /> {t.rd_rail}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMore();
              openGraph("neighbors", path);
            }}
          >
            <Icon name="graph" size={13} /> {t.rd_view_graph}
          </button>
        </>
      ) : null}
      <button
        type="button"
        role="menuitem"
        disabled={isRaw}
        onClick={() => {
          setMode("source");
          closeMore();
        }}
      >
        <Icon name="edit" size={13} /> {t.rd_source}
      </button>
      {mode !== "preview" && paraRuns.length > 0 ? (
        <button
          type="button"
          role="menuitem"
          className="rd-auth-toggle"
          onClick={() => {
            setShowAuthorship((visible) => !visible);
            setPick(null);
            closeMore();
          }}
        >
          <Icon name="history" size={13} />
          {showAuthorship ? t.rd_auth_hide : t.rd_auth_show}
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        disabled={cardBusy}
        onClick={() => {
          closeMore();
          void makeCards();
        }}
      >
        <Icon name="sparkles" size={13} />{" "}
        {cardBusy
          ? (t.rd_making ?? "Generating…")
          : (t.rd_make_cards ?? "Make cards")}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={audioBusy}
        onClick={() => {
          closeMore();
          makeAudio();
        }}
      >
        <Icon name="spark" size={13} />{" "}
        {audioBusy ? (t.au_generating ?? "…") : (t.rd_audio ?? "Audio overview")}
      </button>
      {/\.md$/i.test(path) ? (
        // Ask over this note and its one-hop links (UX S37).
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            closeMore();
            askThisNote();
          }}
        >
          <Icon name="msg" size={13} /> {t.rd_ask_note}
        </button>
      ) : null}
      {/* The note itself, as the tree's context menu offers it (one
          lib). raw/ is immutable: none of these apply there. */}
      <div className="rd-menu__sep" role="separator" />
      {/\.md$/i.test(path) ? (
        <button
          type="button"
          role="menuitem"
          className={starred ? "is-starred" : undefined}
          disabled={isRaw}
          onClick={() => {
            closeMore();
            void toggleFavorite(path);
          }}
        >
          <Icon name="star" size={13} /> {starred ? t.sb_fav_remove : t.sb_fav_add}
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        disabled={isRaw}
        onClick={() => {
          closeMore();
          void renameNote(path, t);
        }}
      >
        <Icon name="edit" size={13} /> {t.sb_rename}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={isRaw}
        onClick={() => {
          closeMore();
          void moveNotes([path], t);
        }}
      >
        <Icon name="folder" size={13} /> {t.sb_move_to}
      </button>
      <button
        type="button"
        role="menuitem"
        className="rd-menu__danger"
        disabled={isRaw}
        onClick={() => {
          closeMore();
          void deleteNotes([path], t);
        }}
      >
        <Icon name="trash" size={13} /> {t.dlg_delete}
      </button>
    </div>
  );
  return (
    <div className="workspace">
      <header className="page-head reader-head" style={{ paddingTop: 40 }}>
        <div className="row" style={{ marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
          {askActive ? (
            <button
              type="button"
              className="chip ask-back"
              onClick={() => setRoute("query")}
            >
              <Icon name="arrowL" size={12} /> {t.q_back_to_ask}
            </button>
          ) : null}
          <span className="typebadge">
            <span className={`tb-dot t-${TYPE_DOTS.has(noteType ?? "") ? noteType : "overview"}`}></span>
            {noteType ?? t.rd_type_note}
          </span>
          {!isRaw && seedGen > 0 ? (
            <span
              className="reader-save-status"
              data-state={saveStatus}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {saveLabel}
            </span>
          ) : null}
        </div>
        <h1 className="page-title" title={path} tabIndex={-1}>
          {noteTitle}
          {phone && !isRaw && seedGen > 0 ? (
            // The save state as a dot at the title's end; the status line
            // above still says it to a screen reader (UX S54).
            <span className="reader-save-dot" data-state={saveStatus} title={saveLabel} aria-hidden="true" />
          ) : null}
        </h1>
        {dailyDay && currentVaultPath ? (
          // ‹ Yesterday · Tomorrow › step to the neighbouring day's note,
          // creating it the way the sidebar's Today's note does. The title
          // names the day each one opens, since "yesterday" is relative to
          // this note, not to today.
          <div className="reader-daynav">
            <Button
              variant="quiet"
              title={shiftDay(dailyDay, -1)}
              onClick={() => void openDailyNote(currentVaultPath, shiftDay(dailyDay, -1))}
            >
              <Icon name="chevL" size={14} />
              {t.rd_day_prev}
            </Button>
            <span aria-hidden="true">·</span>
            <Button
              variant="quiet"
              title={shiftDay(dailyDay, 1)}
              onClick={() => void openDailyNote(currentVaultPath, shiftDay(dailyDay, 1))}
            >
              {t.rd_day_next}
              <Icon name="chevR" size={14} />
            </Button>
          </div>
        ) : null}
        <div className="reader-actions">
          {phone ? null : (
            <>
          <button
            type="button"
            className="btn btn-ghost outline-toggle"
            aria-expanded={railShown}
            // WebKit does not focus a clicked button; the sheet would take
            // <body> as its opener and drop focus there on close.
            onClick={(e) => {
              e.currentTarget.focus();
              toggleRail();
            }}
          >
            <Icon name="columns" size={14} /> {t.rd_rail}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => openGraph("neighbors", path)}
          >
            <Icon name="graph" size={14} /> {t.rd_view_graph}
          </button>
            </>
          )}
          <div className="rd-more" ref={moreRef} onBlur={(e) => {
            if (!sheetMode && !e.currentTarget.contains(e.relatedTarget)) setMoreOpen(false);
          }}>
            <button
              type="button"
              className="btn btn-ghost"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-label={t.rd_more ?? "More"}
              title={t.rd_more ?? "More"}
              onClick={() => setMoreOpen((o) => !o)}
            >
              <Icon name="dotMore" size={14} />
            </button>
            {moreOpen ? (
              sheetMode ? (
                <Sheet title={noteTitle} closeLabel={t.ui_close} onClose={closeMore}>
                  {moreMenu}
                </Sheet>
              ) : (
                moreMenu
              )
            ) : null}
          </div>
        </div>
        {mode === "source" ? (
          <div className="reader-source-notice">
            <span>{t.rd_source_active}</span>
            <button type="button" className="btn btn-ghost" onClick={() => {
              setMode("live");
              // The notice and its button go: focus goes back to writing,
              // the same editor (Live reconfigures it, caret kept).
              editorViewRef.current?.focus();
            }}>
              {t.rd_back_to_write}
            </button>
          </div>
        ) : null}
        {isRaw ? <p className="reader-read-only muted">{t.rd_raw_read_only}</p> : null}
        {cardMsg ? (
          <div className="row" style={{ gap: 10, marginTop: 6 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {cardMsg}
            </span>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12.5 }}
              onClick={() => setRoute("study")}
            >
              {t.rd_open_study ?? "Open study"} →
            </button>
          </div>
        ) : null}
      </header>
      {saveFailed ? (
        <div className="reader-save-error" role="alert">
          <p>{pendingDrafts.has(path) && getEditorRecoveryBaseline(path) !== undefined
            ? t.rd_recovered_draft : t.rd_save_failed}</p>
          <button
            type="button"
            className="btn"
            disabled={isSaving || recoveryBusy}
            onClick={() => { void flushSave(draftRef.current); }}
          >
            {isSaving ? t.rd_saving : t.rd_retry_save}
          </button>
        </div>
      ) : null}
      {recoveryControls}
      {recoveryMessage}
      {error ? (
        <p role="alert" className="muted" style={{ fontSize: 12.5 }}>
          {error}
        </p>
      ) : null}
      {editorError ? (
        <p role="alert" className="muted" style={{ fontSize: 12.5 }}>
          {editorError}
        </p>
      ) : null}
      <div
        ref={setBodyEl}
        className={
          "reader-body" +
          (railOpen && !railSheet ? " reader-body--rail" : "")
        }
      >
        <section style={{ display: "flex", flexDirection: "column", minHeight: "60vh" }}>
          {mode !== "preview" ? (
            <div style={{ flex: 1, minHeight: "60vh", display: "flex" }}>
              {seedGen > 0 ? (
                <Editor
                  docKey={`${path}#${seedGen}`}
                  notePath={path}
                  // `draft`, not `activeFile.raw`: a Preview-mode property edit
                  // must survive a Preview → Source switch inside the autosave
                  // window.
                  initialValue={draft}
                  undoBase={readBase?.gen === seedGen ? readBase.text : undefined}
                  t={t}
                  live={mode === "live"}
                  vaultRoot={currentVaultPath}
                  viewRef={editorViewRef}
                  extras={extras}
                  onChange={(c) => {
                    setDraft(c);
                    scheduleSave(c);
                  }}
                  onSave={(c) => flushSave(c)}
                  onLinkClick={handleLinkClick}
                  onError={setEditorError}
                />
              ) : null}
            </div>
          ) : null}
          {mode === "preview" ? (
            <div className="prose" style={{ flex: 1 }} ref={previewRef}>
              <Viewer
                content={draft}
                vaultRoot={currentVaultPath}
                notePath={path}
                onLinkClick={handleLinkClick}
                sourceLines
                // raw/ is immutable: its boxes stay disabled.
                onToggleTask={isRaw ? undefined : toggleTask}
              />
            </div>
          ) : null}
          {/\.md$/i.test(path) ? (
            <div className="reader-ask-foot">
              <Button onClick={askThisNote}>
                <Icon name="msg" size={14} /> {t.rd_ask_note}
              </Button>
            </div>
          ) : null}
        </section>
        {railOpen && seedGen > 0 && !railSheet ? rail : null}
      </div>
      {sheetOpen && seedGen > 0 && railSheet
        ? createPortal(
            <ReaderRailSheet t={t} onClose={() => setSheetOpen(false)}>
              {rail}
            </ReaderRailSheet>,
            document.body,
          )
        : null}
      {quoteAt ? (
        <div
          className="raw-quote"
          role="group"
          aria-label={t.rd_quote_actions}
          style={{
            left: Math.max(170, Math.min(quoteAt.x, window.innerWidth - 170)),
            top: Math.min(quoteAt.y + 8, window.innerHeight - 64),
          }}
          // Keep the selection: a press would otherwise collapse it first.
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="btn btn-ghost"
            disabled={quoteBusy}
            aria-busy={quoteBusy}
            onClick={() => void quoteToDaily(quoteAt.line)}
          >
            <Icon name="quote" size={13} /> {t.rd_quote_to_daily}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={cardBusy || quoteBusy}
            aria-busy={cardBusy}
            onClick={() => void makeQuoteCard(quoteAt.line, quoteAt.prose)}
          >
            <Icon name="sparkles" size={13} /> {t.rd_quote_to_card}
          </button>
        </div>
      ) : null}
      {pick ? (
        <div
          className="auth-pop"
          role="dialog"
          aria-label={t.rd_auth_title ?? "Who wrote this paragraph"}
          style={{
            left: Math.min(pick.x, window.innerWidth - 280),
            top: pick.y + 8,
          }}
        >
          <p className="auth-pop__who">
            <span className={"auth-dot" + (pick.run.agent ? " is-agent" : "")} aria-hidden="true" />
            {pick.run.agent
              ? (t.rd_auth_agent ?? "Written by the agent")
              : (t.rd_auth_human ?? "Written by you")}
          </p>
          <p className="auth-pop__when">
            {fmtDate(pick.run.ts, lang)}
            {pick.run.sha ? ` · ${pick.run.sha.slice(0, 7)}` : ""}
          </p>
          {pick.run.revertable ? (
            <button className="btn" onClick={() => void revertParagraph(pick.run)}>
              ↺ {t.rd_auth_revert ?? "Revert this paragraph"}
            </button>
          ) : (
            <>
              {/* Nothing to revert on a paragraph the user wrote; a disabled
                  button there would answer a question nobody asked. */}
              {pick.run.agent ? (
                <button className="btn" disabled>
                  ↺ {t.rd_auth_revert ?? "Revert this paragraph"}
                </button>
              ) : null}
              <p className="auth-pop__when">
                {pick.run.agent
                  ? (t.rd_auth_locked ??
                    "More than one commit wrote this paragraph — there is no single version to go back to.")
                  : (t.rd_auth_human_only ?? "No agent edit here to revert.")}
              </p>
              <button className="btn btn-ghost" onClick={() => setRoute("history")}>
                {t.rd_auth_history ?? "See it in history"} →
              </button>
            </>
          )}
        </div>
      ) : null}
      {claimPick ? (
        <div
          className="auth-pop"
          role="dialog"
          aria-label={t.rd_claim_title ?? "Claim with no source"}
          style={{
            left: Math.min(claimPick.x, window.innerWidth - 300),
            top: claimPick.y + 8,
          }}
        >
          <p className="auth-pop__who">
            <span className="auth-dot is-warn" aria-hidden="true" />
            {t.rd_claim_title ?? "Claim with no source"}
          </p>
          {claimHits === null ? (
            <>
              <p className="auth-pop__when">
                {t.rd_claim_hint ?? "Nothing in this paragraph points at a source."}
              </p>
              <button className="btn" onClick={() => void findSources(claimPick.claim)}>
                ◇ {t.rd_claim_find ?? "Find a source"}
              </button>
            </>
          ) : claimHits === "loading" ? (
            <p className="auth-pop__when">{t.rd_claim_searching ?? "Searching the vault…"}</p>
          ) : claimHits.length === 0 ? (
            <p className="auth-pop__when">
              {t.rd_claim_none ?? "Nothing in the vault supports this — leaving it uncited."}
            </p>
          ) : (
            <ul className="rail-list">
              {claimHits.map((h) => (
                <li key={`${h.page}#${h.section}`}>
                  <button
                    type="button"
                    className="rail-conn__name"
                    title={h.page}
                    onClick={() => citeClaim(claimPick.claim, h.page)}
                  >
                    {h.stem}
                  </button>
                  <span className="rail-n">
                    {((h.similarity ?? h.score) * 100).toFixed(0)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {audioActive ? <AudioOverviewPanel t={t} /> : null}
      {/* Mount only while a PDF is open: the viewer renders null otherwise, and
          mounting the lazy component would fetch pdf.js for every note. */}
      {pdfOpen ? (
        <Suspense
          fallback={
            <p className="muted" style={{ padding: 16 }}>{t.pdf_loading ?? "Loading PDF…"}</p>
          }
        >
          <PdfViewer t={t} />
        </Suspense>
      ) : null}
    </div>
  );
}

/** What the reader shows for `path`: its current read's failure takes priority
 *  over a cached file. Without a failure, show the matching file or loading.
 *  Exported for its unit test. */
export function readerView(
  openPath: string | undefined,
  path: string,
  error: string | null | undefined,
): "ready" | "loading" | "missing" | "unreadable" {
  if (error !== null && error !== undefined) return NOT_FOUND.test(error) ? "missing" : "unreadable";
  return openPath === path ? "ready" : "loading";
}

/** A read that failed because the file is gone: canonicalize's ENOENT
 *  (confine_path or vault::read_file), read_file on a folder, or the mock's
 *  own "no such file". */
const NOT_FOUND = /\(os error 2\)|no such file|^not a file:/i;

/** Types with a dot colour of their own (styles.css `.t-*`). */
const TYPE_DOTS = new Set(["overview", "source", "entity", "concept", "technique", "analysis"]);

/** A frontmatter value that is a non-blank string, trimmed, else null. */
function fmString(fm: Frontmatter | null, key: string): string | null {
  const v = getValue(fm, key);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The root font size: the rail's widths are in rem. */
function remPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** Author time as a plain date; the gutter needs a stamp, not a countdown. */
function fmtDate(ts: number, lang: string): string {
  if (!ts) return "—";
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
}
