// Editor: CodeMirror 6 with markdown language, soft wrap, and wikilink
// autocomplete. The component is uncontrolled — it owns the EditorView
// lifecycle and emits onChange on every doc change, onSave on Cmd/Ctrl-S.
// Parent passes initial value via the docKey prop to remount when switching
// files.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JSX, MutableRefObject } from "react";
import {
  Compartment,
  EditorState,
  Prec,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  autocompletion,
  closeCompletion,
  completionKeymap,
  completionStatus,
  selectedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSection,
} from "@codemirror/autocomplete";
import { search, searchKeymap } from "@codemirror/search";
import { useVaultStore } from "../stores/vaultStore";
import { ipc } from "../lib/ipc";
import { assetFileName, imageExtFor } from "../lib/assets";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Strings } from "../lib/i18n";
import { liveExtension } from "../lib/editorLive";
import { blockWidgets, reconfigureLive } from "../lib/blocks/live";
import { loadEmbed } from "../lib/embedLoad";
import { queryRunner } from "../lib/queryLoad";
import { calloutBlocks } from "../lib/blocks/calloutLive";
import {
  blockHandle,
  blockMenuKeymap,
  type BlockMenuRequest,
} from "../lib/editorBlockHandle";
import BlockMenu from "./BlockMenu";
import EditorToolbar from "./EditorToolbar";
import { useMediaQuery, useSheetMode } from "./ui";
import { focusIsIdle } from "./AppPage";
import RecallPicker, {
  OnThisDayPicker,
  type RecallRequest,
} from "./RecallPicker";
import {
  applySlash,
  blockKeymap,
  bodyStart,
  liveEditing,
  mycoMarkdown,
} from "../lib/editorBlocks";
import { inCode } from "../lib/editorMarks";
import { formatKeymap, linkApply } from "../lib/editorFormat";
import {
  bodyTagQueryAt,
  filterSlash,
  slashItems,
  slashQueryAt,
  slashSectionNames,
  slashSectionRank,
  tagQueryAt,
  type SlashItem,
  type SlashPicker,
  wikilinkOptions,
  wikilinkQueryAt,
} from "../lib/editorCompletions";
import { refreshSlashTemplates, slashTemplates } from "../lib/templates";
import { redrawStartChips, startChips, startChipsField } from "../lib/startChips";
import { dailyDayOf } from "../lib/dailyNote";
import {
  pluginFenceKey,
  pluginSlash,
  usePluginStore,
} from "../stores/pluginStore";
import { runPluginCommand } from "../lib/pluginRuntime";
import { useUIStore } from "../stores/uiStore";
import { tagCandidates } from "../lib/tagIndex";
import { subscribeNoteWriting, takeNoteWritingRequest } from "../lib/noteWriting";
import { flattenMarkdown, stem } from "../lib/graphData";
import {
  blockInsertionResult,
  insertBlockTr,
  noteHeadings,
} from "../lib/editorRecall";
import { insertionRange } from "../lib/readerRail";
import { noteContentCompletion } from "../lib/inNotesCompletion";

export interface EditorProps {
  docKey: string;
  /** Vault path for a one-time explicit new-note focus request. */
  notePath?: string;
  initialValue: string;
  /** The text before edits made while no editor was open (a Read-mode
   *  tick): the editor opens on it and applies the difference as its first
   *  undo step, so ⌘Z takes the tick back. Read once, at mount. */
  undoBase?: string;
  t: Strings;
  /** Live preview: marks hidden off the caret line, tasks/bullets rendered. */
  live: boolean;
  /** With `notePath`, Live's image blocks load through the asset protocol. */
  vaultRoot?: string;
  /** Live handle to the view, for callers that dispatch their own transactions. */
  viewRef?: MutableRefObject<EditorView | null>;
  /** Extensions the page composes on top (authorship gutter, claim markers).
   *  Reconfigured through a compartment, so changing them keeps the cursor,
   *  scroll and undo history a remount would lose. */
  extras?: Extension;
  onChange?: (value: string) => void;
  onSave?: (value: string) => void;
  /** Mod-click on a wikilink in Live mode; a TOC row also gives its
   *  heading's body line. */
  onLinkClick?: (target: string, line?: number) => void;
  /** An image failure or a block insertion that needs a retry. */
  onError?: (message: string) => void;
}

export default function Editor({
  docKey,
  notePath,
  initialValue,
  undoBase,
  t,
  live,
  vaultRoot,
  viewRef,
  extras,
  onChange,
  onSave,
  onLinkClick,
  onError,
}: EditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const localViewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onLinkClickRef = useRef(onLinkClick);
  const onErrorRef = useRef(onError);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onLinkClickRef.current = onLinkClick;
  onErrorRef.current = onError;
  // Identity tokens only; the same Compartments reconfigure every view we make.
  const liveComp = useRef(new Compartment()).current;
  // The enabled plugins' fences: a change redraws Live's blocks.
  const fenceKey = usePluginStore(pluginFenceKey);
  const [menu, setMenu] = useState<BlockMenuRequest | null>(null);
  const [picker, setPicker] = useState<RecallRequest | null>(null);
  // Touch (UX S51): the keyboard toolbar while the editor has focus, and the
  // block menu as a sheet.
  const touch = useMediaQuery("(any-pointer: coarse)");
  const sheetMenu = useSheetMode();
  const [toolView, setToolView] = useState<EditorView | null>(null);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(false);
  // `/recall` etc.: the picker opens under the caret's line (above it near
  // the window's bottom). `/image` opens the native file dialog instead.
  // `question`: the block menu's "Ask about this block" opens `/ask` on it.
  const openPicker = (
    view: EditorView,
    mode: SlashPicker,
    pos: number,
    question?: string,
  ) => {
    if (mode === "image") {
      void pickImage(view, pos);
      return;
    }
    const c = view.coordsAtPos(pos) ?? view.coordsAtPos(pos, -1);
    setPicker({
      view,
      mode,
      pos,
      question,
      x: c?.left ?? 0,
      y: c ? c.bottom + 4 : 0,
      above: c ? c.top - 4 : 0,
    });
  };
  const extrasComp = useRef(new Compartment()).current;
  const reportUnsupported = () =>
    onErrorRef.current?.(
      t.img_unsupported ??
        "Only PNG, JPEG, GIF and WebP images can be inserted",
    );
  const reportFailed = (err: unknown) =>
    onErrorRef.current?.(
      (t.img_failed ?? "Image could not be saved: {error}").replace(
        "{error}",
        String(err),
      ),
    );
  // `/image`: the chosen file is copied under assets/ as a dropped one is,
  // and `![](assets/…)` goes in as a block of its own where `/image` was —
  // as /recall inserts — never glued into the text around it.
  async function pickImage(view: EditorView, pos: number): Promise<void> {
    let path: string | null = null;
    try {
      path = await ipc.pickImageFile();
    } catch (err) {
      reportFailed(err);
    }
    if (!view.dom.isConnected) return;
    view.focus();
    if (!path) return;
    const ext = imageExtFor("", path);
    if (!ext) return reportUnsupported();
    let rel: string;
    try {
      rel = await ipc.copyAsset(assetFileName(new Date(), ext), path);
    } catch (err) {
      return reportFailed(err);
    }
    // The view was destroyed while the file was copied (note switched).
    if (!view.dom.isConnected) return;
    // The native dialog is modal: nothing edits the doc meanwhile but a
    // reload, so clamping the position is enough.
    const at = Math.min(pos, view.state.doc.length);
    view.dispatch(insertBlockTr(view.state, at, `![](${rel})`));
  }

  useEffect(() => {
    if (!containerRef.current) return;
    // CodeMirror's text: every `\r\n` is one `\n`, as bodyStart counts.
    const value = initialValue.replace(/\r\n?/g, "\n");
    const base = undoBase?.replace(/\r\n?/g, "\n");
    const replay = base === undefined ? null : insertionRange(base, value);
    const doc = replay ? (base as string) : initialValue;
    // Set while the replayed edit dispatches: the page already has that text.
    let replaying = false;
    // The vault's `slash:` templates, then the enabled plugins' items;
    // {{title}} = this note's name. A plugin command runs in its worker.
    const templateItems = (): SlashItem[] => {
      const title = notePath ? stem(notePath) : "";
      return [
        ...slashTemplates(title),
        ...pluginSlash(title, (p, command, v) => {
          void runPluginCommand(p, command, v, t);
        }),
      ];
    };

    const state = EditorState.create({
      doc,
      // Past the frontmatter (and a new note's seed title), never offset 0:
      // typing there broke the YAML or landed above the title.
      selection: { anchor: bodyStart(doc) },
      extensions: [
        history(),
        search({ top: true }),
        EditorState.phrases.of(cmPhrases(t)),
        blockKeymap(t, openPicker, templateItems, refreshSlashTemplates),
        blockMenuKeymap(setMenu),
        // ⌘B/⌘I/⌘E/⌘K/⌘⇧H, ahead of defaultKeymap's Mod-i.
        formatKeymap(),
        keymap.of([
          {
            key: "Mod-s",
            run: (view) => {
              onSaveRef.current?.(view.state.doc.toString());
              return true;
            },
            preventDefault: true,
          },
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
        ]),
        mycoMarkdown(),
        liveComp.of([]),
        extrasComp.of([]),
        EditorView.lineWrapping,
        belowTopbar,
        // CodeMirror's default caret is black — invisible on the dark theme. A
        // theme extension wins over CM's injected base styles (a plain stylesheet
        // rule loses to them), so set the caret + cursor to the theme ink here.
        EditorView.theme({
          "&": { color: "var(--ink)" },
          ".cm-content": { caretColor: "var(--ink)" },
          ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground":
            { background: "var(--bg-hover)" },
          // Search panel and completion tooltip follow the app theme (dark too).
          ".cm-panels": {
            background: "var(--bg-soft)",
            color: "var(--ink)",
            borderColor: "var(--line)",
          },
          ".cm-textfield, .cm-button": {
            background: "var(--bg-elev)",
            borderColor: "var(--line)",
            color: "var(--ink)",
          },
          ".cm-tooltip": {
            background: "var(--bg-elev)",
            borderColor: "var(--line)",
            boxShadow: "var(--shadow-pop)",
          },
          ".cm-tooltip-autocomplete ul li[aria-selected]": {
            background: "var(--bg-active)",
            color: "var(--ink)",
          },
          // Slash menu: localized names in the UI face, sections, text icons.
          // Selectors match the base theme's specificity so these win.
          ".cm-tooltip.cm-tooltip-autocomplete > ul": {
            fontFamily: "var(--font-sans)",
            maxHeight: "min(22em, 50vh)",
          },
          ".cm-tooltip.cm-tooltip-autocomplete > ul > completion-section": {
            borderBottom: "0",
            padding: "8px 8px 2px",
            fontSize: "11px",
            color: "var(--ink-4)",
            opacity: "1",
          },
          ".cm-tooltip.cm-tooltip-autocomplete > ul > li.cm-slash-opt": {
            display: "flex",
            alignItems: "center",
            padding: "3px 8px",
          },
          ".cm-slash-opt .cm-completionIcon, .cm-slash-none .cm-completionIcon":
            { display: "none" },
          ".cm-slash-icon": {
            flex: "none",
            width: "2.4em",
            marginRight: "8px",
            textAlign: "center",
            fontSize: "11px",
            fontWeight: "600",
            lineHeight: "1.8",
            color: "var(--ink-3)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-sm)",
            background: "var(--bg)",
          },
          ".cm-slash-opt .cm-completionDetail": {
            marginLeft: "auto",
            paddingLeft: "16px",
            fontStyle: "normal",
            fontFamily: "var(--font-mono)",
            fontSize: "12.5px",
            color: "var(--ink-4)",
          },
          ".cm-tooltip-autocomplete ul li.cm-slash-none, .cm-tooltip-autocomplete ul li.cm-slash-none[aria-selected]":
            {
              padding: "4px 8px",
              background: "transparent",
              color: "var(--ink-4)",
              cursor: "default",
            },
          // `[[` "In notes": the chunk a hit came from, line breaks kept.
          ".cm-tooltip.cm-completionInfo": {
            maxWidth: "min(28em, 60vw)",
            whiteSpace: "pre-line",
            fontFamily: "var(--font-sans)",
            fontSize: "12.5px",
            color: "var(--ink-3)",
          },
          ".cm-searchMatch": { background: "var(--accent-soft)" },
          ".cm-searchMatch.cm-searchMatch-selected": {
            background: "var(--bg-active)",
          },
        }),
        // Same precedence as the completion keymap and listed before it, so
        // it runs first.
        Prec.highest(
          keymap.of([
            { key: "Enter", run: passNoResults },
            { key: "Tab", run: passNoResults },
            { key: "ArrowDown", run: passNoResults },
            { key: "ArrowUp", run: passNoResults },
            { key: "PageDown", run: passNoResults },
            { key: "PageUp", run: passNoResults },
          ]),
        ),
        autocompletion({
          override: [
            slashCompletion(t, openPicker, templateItems),
            wikilinkCompletion,
            noteContentCompletion(t),
            headingCompletion,
            tagCompletion,
          ],
          optionClass: (c) =>
            NO_RESULTS in c ? "cm-slash-none" : "icon" in c ? "cm-slash-opt" : "",
          addToOptions: [{ render: slashIcon, position: 20 }],
        }),
        // Image paste → assets/. A clipboard holding text AND an image pastes
        // the image (Obsidian/Notion); with no files CM's text paste proceeds.
        EditorView.domEventHandlers({
          paste: (e, view) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length === 0) return false;
            e.preventDefault();
            const images = files.flatMap((f) => {
              const ext = imageExtFor(f.type, f.name);
              return ext ? [[f, ext] as const] : [];
            });
            if (images.length === 0) {
              reportUnsupported();
              return true;
            }
            void insertImages(
              view,
              images.map(
                ([f, ext]) =>
                  async () =>
                    ipc.writeAsset(
                      assetFileName(new Date(), ext),
                      new Uint8Array(await f.arrayBuffer()),
                    ),
              ),
              reportFailed,
            );
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          for (const transaction of update.transactions)
            for (const effect of transaction.effects)
              if (effect.is(blockInsertionResult))
                onErrorRef.current?.(effect.value ? "" : t.editor_insert_wait);
          if (update.focusChanged) {
            setToolView(update.view);
            setEditing(update.view.hasFocus);
          }
          if (update.focusChanged || update.selectionSet)
            setSelected(!update.state.selection.main.empty);
          if (update.docChanged) {
            if (!replaying) onChangeRef.current?.(update.state.doc.toString());
            // The menu judged its actions on the old doc.
            setMenu(null);
            // The picker's insert point follows the text it was opened at.
            setPicker((p) =>
              p && { ...p, pos: update.changes.mapPos(p.pos) },
            );
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    if (replay) {
      replaying = true;
      view.dispatch({ changes: replay, userEvent: "input" });
      replaying = false;
    }
    localViewRef.current = view;
    if (viewRef) viewRef.current = view;
    // Read templates/ now: only a `/` query reads it otherwise, so a fast
    // `/meeting⏎` before any menu had answered found no template — and an
    // empty note's start chips (S24) draw once it is read.
    void refreshSlashTemplates().then(() => {
      if (view.dom.isConnected) view.dispatch({ effects: redrawStartChips.of(null) });
    });
    // A brand-new note routes straight here and should land with the cursor
    // ready. Focus only when focus is idle (on <body> after the naming dialog
    // closed, or on the title the route change parked it on), so mounting
    // never steals focus from another input.
    if (focusIsIdle(document)) view.focus();

    let focusFrame: number | undefined;
    const focusRequestedNote = (path: string): void => {
      if (path !== notePath) return;
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      // Consume after effects settle: StrictMode's first cleanup can cancel
      // this frame without losing the intent, and Live's marks are ready.
      focusFrame = requestAnimationFrame(() => {
        if (!takeNoteWritingRequest(path)) return;
        view.dispatch({
          selection: { anchor: view.state.doc.length },
          scrollIntoView: true,
        });
        view.focus();
      });
    };
    const unsubscribeWriting = subscribeNoteWriting(focusRequestedNote);
    if (notePath) focusRequestedNote(notePath);

    return () => {
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      unsubscribeWriting();
      localViewRef.current = null;
      if (viewRef) viewRef.current = null;
      view.destroy();
    };
    // We intentionally remount on docKey change rather than diffing doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, notePath]);

  // One configuration path for Live: reconfiguring the compartment keeps the
  // cursor, scroll and undo history that a remount would lose. Runs after the
  // mount effect above on every new view (same docKey dependency).
  useEffect(() => {
    const v = viewRef?.current ?? localViewRef.current;
    if (!v) return;
    reconfigureLive(
      v,
      liveComp,
      live
        ? [
            liveExtension({
              onLinkClick: (x) => onLinkClickRef.current?.(x),
              onExternalLink: (href) => void ipc.openExternal(href),
              taskLabel: t.rd_task_toggle ?? "Toggle task",
              fmLabel:
                t.rd_frontmatter_hidden ??
                "Frontmatter hidden — edit in Properties or Source",
              headingLabels: [
                t.sl_h1 ?? "Heading 1",
                t.sl_h2 ?? "Heading 2",
                t.sl_h3 ?? "Heading 3",
                t.sl_h4 ?? "Heading 4",
              ],
              blockLabel: t.live_ph_block ?? "Type '/' for blocks",
              sourcesLabel: t.live_sources,
            }),
            liveEditing(),
            blockWidgets({
              // Same mapping as Viewer's, so Live and Preview load one URL.
              env: {
                vaultRoot,
                noteDir: notePath?.replace(/[\\/][^\\/]+$/, ""),
                toUrl: convertFileSrc,
              },
              t,
              onLinkClick: (x, line) => onLinkClickRef.current?.(x, line),
              onExternalLink: (href) => void ipc.openExternal(href),
              loadEmbed,
              // One per open: a widget drawn again reuses its run.
              runQuery: queryRunner(notePath),
            }),
            calloutBlocks(t),
            // S24: under an empty note's `/` hint, starters to pick.
            startChipsField(
              () =>
                startChips(
                  slashTemplates(notePath ? stem(notePath) : ""),
                  Boolean(notePath && vaultRoot && dailyDayOf(notePath, vaultRoot)),
                  t,
                ),
              t.start_chips_label ?? "Start with",
            ),
            blockHandle(setMenu, t.bm_handle ?? "Block menu"),
          ]
        : [],
    );
    // Labels refresh on the next file open, not on a language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, docKey, fenceKey]);

  // Same one-configuration-path rule as Live, for the page's own extensions.
  useEffect(() => {
    const v = viewRef?.current ?? localViewRef.current;
    if (!v) return;
    v.dispatch({ effects: extrasComp.reconfigure(extras ?? []) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extras, docKey]);

  // Image drop from Finder → assets/. HTML5 drop never reaches WebKit under
  // Tauri on macOS (wry claims the drag), so listen to Tauri's native event and
  // hit-test its position against this container: PageIngest subscribes to the
  // same event while mounted (split view), and drops outside the editor stay its.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // wry (wkwebview/drag_drop.rs) reports NSView draggingLocation — view
    // points, i.e. CSS px from the webview's top-left — wrapped as a
    // PhysicalPosition unscaled, so it compares directly with the client rect.
    // ponytail: Windows/Linux really are physical; divide by devicePixelRatio there.
    const hits = (pos: { x: number; y: number }): boolean => {
      const r = el.getBoundingClientRect();
      return (
        pos.x >= r.left &&
        pos.x <= r.right &&
        pos.y >= r.top &&
        pos.y <= r.bottom
      );
    };
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const u = await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "leave") {
          el.classList.remove("is-drop-target");
          return;
        }
        const hit = hits(p.position);
        if (p.type !== "drop") {
          el.classList.toggle("is-drop-target", hit);
          return;
        }
        el.classList.remove("is-drop-target");
        const view = localViewRef.current;
        if (!hit || !view) return;
        const images = p.paths.flatMap((path) => {
          const ext = imageExtFor("", path);
          return ext ? [[path, ext] as const] : [];
        });
        if (images.length === 0) {
          reportUnsupported();
          return;
        }
        void insertImages(
          view,
          images.map(
            ([path, ext]) =>
              () =>
                ipc.copyAsset(assetFileName(new Date(), ext), path),
          ),
          reportFailed,
        );
      });
      // Unmounted before the listener resolved (note switched): drop it now.
      if (cancelled) u();
      else unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // Error labels refresh on the next file open, like the paste path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const Picker = picker?.mode === "onthisday" ? OnThisDayPicker : RecallPicker;
  return (
    <>
      <div
        ref={containerRef}
        className={live ? "myco-editor live" : "myco-editor"}
      />
      {menu
        ? createPortal(
            <BlockMenu
              t={t}
              req={menu}
              sheet={sheetMenu}
              onClose={(refocus) => {
                setMenu(null);
                if (refocus) menu.view.focus();
              }}
              onAsk={(question, pos) =>
                openPicker(menu.view, "ask", pos, question)
              }
            />,
            document.body,
          )
        : null}
      {touch && toolView?.dom.isConnected ? (
        <EditorToolbar
          t={t}
          view={toolView}
          editing={editing}
          selected={selected}
          onMenu={(pos) => setMenu({ view: toolView, pos, x: 0, y: 0 })}
          openPicker={(mode, pos) => openPicker(toolView, mode, pos)}
        />
      ) : null}
      {picker
        ? createPortal(
            <Picker
              t={t}
              req={picker}
              onClose={(refocus) => {
                setPicker(null);
                if (refocus) picker.view.focus();
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * How much of the editor's scroller the sticky `.topbar` covers: all of it
 * when the document scrolls (scroller top at or above the window's), none in
 * a split pane, whose scroller starts under the bar.
 */
export function topbarOverlap(barBottom: number, scrollerTop: number): number {
  return Math.max(0, barBottom - Math.max(0, scrollerTop));
}

// CodeMirror keeps a scroll target 5px from the scroller's edge and knows
// nothing of the sticky bar: a jump to a heading (search, study, Ask) and the
// caret near the top landed under it. The scroller is the first overflowing
// ancestor, the test CodeMirror picks its own scroll parent by. None while a
// completion is open: the tooltip reads the margin as the editor's visible
// top too, and hid the menu typed on the note's first line (`/` in an empty
// note); its arrow keys move the menu, not the caret.
const belowTopbar = EditorView.scrollMargins.of((view) => {
  const doc = view.dom.ownerDocument;
  const bar = doc.querySelector(".topbar");
  if (!bar || completionStatus(view.state)) return null;
  let el = view.dom.parentElement;
  while (el && el !== doc.body && el.scrollHeight <= el.clientHeight)
    el = el.parentElement;
  const top = el && el !== doc.body ? el.getBoundingClientRect().top : 0;
  return { top: topbarOverlap(bar.getBoundingClientRect().bottom, top) };
});

/** Put the caret on 1-based `line1` (clamped) and scroll that line to the top. */
export function scrollEditorToLine(view: EditorView, line1: number): void {
  const { doc } = view.state;
  const line = doc.line(Math.max(1, Math.min(line1, doc.lines)));
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: "start" }),
  });
  view.focus();
}

/**
 * Run each `save` (resolves to the vault-relative `assets/…` path) and insert
 * `![|](assets/…)` at the caret. Shared by paste (bytes) and drop (path).
 */
async function insertImages(
  view: EditorView,
  saves: readonly (() => Promise<string>)[],
  onError: (err: unknown) => void,
): Promise<void> {
  // Track the insert point ourselves: the first image replaces the selection
  // (caret lands inside its `[]`), later ones append after it. Re-reading the
  // selection after each insert would nest the next link in that alt text.
  let { from, to } = view.state.selection.main;
  let inserted = false;
  for (const save of saves) {
    try {
      const rel = await save();
      // The view was destroyed while the bytes were in flight (note switched).
      if (!view.dom.isConnected) return;
      const md = (inserted ? "\n" : "") + "![](" + rel + ")";
      view.dispatch({
        changes: { from, to, insert: md },
        selection: inserted ? undefined : { anchor: from + 2 },
        scrollIntoView: true,
      });
      from = to = from + md.length;
      inserted = true;
    } catch (err) {
      onError(err);
    }
  }
}

/** CodeMirror search/autocomplete UI phrase → its `t.cm_*` key. */
const CM_PHRASES: Record<string, keyof Strings> = {
  Find: "cm_find",
  Replace: "cm_replace_field",
  next: "cm_next",
  previous: "cm_previous",
  all: "cm_all",
  "match case": "cm_match_case",
  "by word": "cm_by_word",
  regexp: "cm_regexp",
  replace: "cm_replace",
  "replace all": "cm_replace_all",
  close: "cm_close",
  "current match": "cm_current_match",
  "replaced $ matches": "cm_replaced_matches",
  "replaced match on line $": "cm_replaced_on_line",
  "on line": "cm_on_line",
  "Go to line": "cm_goto_line",
  go: "cm_go",
  Completions: "cm_completions",
};

/** Translations for EditorState.phrases; a missing key keeps CM's English. */
function cmPhrases(t: Strings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [phrase, key] of Object.entries(CM_PHRASES)) {
    const v = t[key];
    if (v) out[phrase] = v;
  }
  return out;
}

/** Marks the "No results" row: a notice, not an item (see passNoResults). */
const NO_RESULTS = "noResults";

/** Enter, Tab, the arrows and PageUp/PageDown on "No results" close it and
 *  then do what they do in text, so an unknown `/word` (a path like `/usr`)
 *  never swallows a key. Above the completion keymap: this must come before
 *  `autocompletion()` in the extension list. */
function passNoResults(view: EditorView): boolean {
  const c = selectedCompletion(view.state);
  if (c && NO_RESULTS in c) closeCompletion(view);
  return false;
}

/** The slash item's text icon, in place of CodeMirror's type icon. */
function slashIcon(c: Completion): Node | null {
  if (!("icon" in c)) return null;
  const el = document.createElement("span");
  el.className = "cm-slash-icon";
  el.setAttribute("aria-hidden", "true");
  el.textContent = String(c.icon);
  return el;
}

/** `/` blocks, then `more` (the vault's `slash:` templates, re-read for
 *  each query). Unfiltered: filterSlash already matched label, alias or
 *  localized name. The localized name leads and the keyword follows; sections
 *  only while browsing (an empty query), so a filtered list stays best-first;
 *  a template's own section sorts after Templates, before Plugins. */
function slashCompletion(
  t: Strings,
  openPicker: (view: EditorView, mode: SlashPicker, pos: number) => void,
  more: () => SlashItem[],
) {
  const names = slashSectionNames(t);
  const sectionOf = (i: SlashItem): CompletionSection => ({
    name: i.sectionName ?? names[i.section],
    rank: slashSectionRank(i),
  });
  return async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    if (inCode(context.state, context.pos)) return null;
    const line = context.state.doc.lineAt(context.pos);
    const m = slashQueryAt(line.text.slice(0, context.pos - line.from));
    if (!m) return null;
    const from = line.from + m.from;
    // Every query, not only the bare `/`: `/meeting` typed on is one query.
    await refreshSlashTemplates();
    if (context.aborted) return null;
    const items = filterSlash([...slashItems(t), ...more()], m.query);
    // Words past a space that match nothing are prose, not a missed command.
    if (!items.length && m.query.includes(" ")) return null;
    if (!items.length) {
      const none: Completion & Record<typeof NO_RESULTS, true> = {
        label: m.query,
        displayLabel: t.sl_no_results ?? "No results",
        [NO_RESULTS]: true,
        apply: (view: EditorView) => closeCompletion(view),
      };
      return { from, filter: false, options: [none] };
    }
    return {
      from,
      filter: false,
      // ko: the English keyword still matches, but is not shown beside the
      // name (S29) — a column of English read as noise there.
      options: items.map((i) => ({
        label: i.label,
        displayLabel: i.detail,
        ...(useUIStore.getState().lang === "ko" ? {} : { detail: i.label }),
        ...(i.hint ? { info: i.hint } : {}),
        icon: i.icon,
        ...(m.query ? {} : { section: sectionOf(i) }),
        apply: (view: EditorView, _c: unknown, from: number, to: number) =>
          applySlash(view, i, from, to, (mode, pos) =>
            openPicker(view, mode, pos),
          ),
      })),
    };
  };
}

/** Frontmatter `tags:` values and body `#tag`s from the vault's indexed tags.
 *  Both apply the bare tag, so the typed `#` stays in place. */
function tagCompletion(context: CompletionContext): CompletionResult | null {
  const prefix = context.state.doc.sliceString(0, context.pos);
  const inFrontmatter = tagQueryAt(prefix);
  const m = inFrontmatter ?? bodyTagQueryAt(prefix);
  if (!m) return null;
  // A bare `#` in the body is usually a heading being typed: wait for one
  // character (or an explicit Ctrl-Space) before offering tags.
  if (!inFrontmatter && m.query === "" && !context.explicit) return null;
  const tags = useVaultStore.getState().adjacency?.tags ?? {};
  const options = tagCandidates(tags, m.query);
  if (options.length === 0) return null;
  return {
    from: m.from,
    options: options.map((label) => ({ label, type: "text" })),
  };
}

export function wikilinkCompletion(
  context: CompletionContext,
): CompletionResult | null {
  // Match either after `[[` or while typing inside an unclosed `[[…`.
  const before = context.matchBefore(/\[\[([^\]\n]*)$/);
  if (!before) return null;
  if (before.from === before.to && !context.explicit) return null;
  const query = before.text.slice(2).toLowerCase();
  const { fileTree, currentVault } = useVaultStore.getState();
  const { options, cut } = wikilinkOptions(fileTree, currentVault?.path ?? "", query);
  if (options.length === 0) return null;
  return {
    from: before.from + 2,
    options: options.map((o) => ({
      ...o,
      type: "text",
      apply: linkApply(`${o.label}]]`),
    })),
    // A list cut at 30 is asked again as typing narrows it: kept valid,
    // CodeMirror would only filter those 30 and miss every other note.
    ...(cut ? {} : { validFor: /^[^\]\n]*$/ }),
  };
}

/** `[[note#` → that note's headings; `[[#` → this note's own. */
async function headingCompletion(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const line = context.state.doc.lineAt(context.pos);
  const m = wikilinkQueryAt(line.text.slice(0, context.pos - line.from));
  if (!m || m.note === null) return null;
  const name = (m.note.split("/").pop() ?? "").trim().toLowerCase();
  let raw: string | null = context.state.doc.toString();
  if (name) {
    const path = flattenMarkdown(useVaultStore.getState().fileTree).find(
      (p) => stem(p).toLowerCase() === name,
    );
    raw = path ? ((await ipc.readFile(path).catch(() => null))?.raw ?? null) : null;
  }
  if (raw === null || context.aborted) return null;
  const heads = noteHeadings(raw);
  return heads.length
    ? {
        from: line.from + m.from,
        options: heads.map((label) => ({
          label,
          type: "text",
          apply: linkApply(`${label}]]`),
        })),
        validFor: /^[^\]\n#|]*$/,
      }
    : null;
}
