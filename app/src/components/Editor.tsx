// Editor: CodeMirror 6 with markdown language, soft wrap, and wikilink
// autocomplete. The component is uncontrolled — it owns the EditorView
// lifecycle and emits onChange on every doc change, onSave on Cmd/Ctrl-S.
// Parent passes initial value via the docKey prop to remount when switching
// files.

import { useEffect, useRef } from "react";
import type { JSX, MutableRefObject } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  snippetCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { search, searchKeymap } from "@codemirror/search";
import { useVaultStore } from "../stores/vaultStore";
import { ipc } from "../lib/ipc";
import type { FileNode } from "../lib/ipc";
import { assetFileName, imageExtFor } from "../lib/assets";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Strings } from "../lib/i18n";
import { liveExtension } from "../lib/editorLive";
import {
  bodyTagQueryAt,
  filterSlash,
  slashItems,
  slashQueryAt,
  tagQueryAt,
} from "../lib/editorCompletions";
import { tagCandidates } from "../lib/tagIndex";

export interface EditorProps {
  docKey: string;
  initialValue: string;
  t: Strings;
  /** Live preview: marks hidden off the caret line, tasks/bullets rendered. */
  live: boolean;
  /** Live handle to the view, for callers that dispatch their own transactions. */
  viewRef?: MutableRefObject<EditorView | null>;
  onChange?: (value: string) => void;
  onSave?: (value: string) => void;
  /** Mod-click on a wikilink in Live mode. */
  onLinkClick?: (target: string) => void;
  /** A paste that could not become an image (unsupported type, IPC failure). */
  onError?: (message: string) => void;
}

export default function Editor({
  docKey,
  initialValue,
  t,
  live,
  viewRef,
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
  // Identity token only; the same Compartment reconfigures every view we make.
  const liveComp = useRef(new Compartment()).current;
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

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        history(),
        search({ top: true }),
        EditorState.phrases.of(cmPhrases(t)),
        keymap.of([
          {
            key: "Mod-s",
            run: (view) => {
              onSaveRef.current?.(view.state.doc.toString());
              return true;
            },
            preventDefault: true,
          },
          // completionKeymap binds Enter only; Tab applies too (Obsidian/Notion).
          // Returns false with no completion open, so Tab is otherwise unchanged.
          { key: "Tab", run: acceptCompletion },
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
        ]),
        // GFM base: Task/Strikethrough nodes exist only here (Live relies on them).
        markdown({ base: markdownLanguage }),
        liveComp.of([]),
        EditorView.lineWrapping,
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
          ".cm-searchMatch": { background: "var(--accent-soft)" },
          ".cm-searchMatch.cm-searchMatch-selected": {
            background: "var(--bg-active)",
          },
        }),
        autocompletion({
          override: [slashCompletion(t), wikilinkCompletion, tagCompletion],
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
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    localViewRef.current = view;
    if (viewRef) viewRef.current = view;
    // A brand-new note routes straight here and should land with the cursor
    // ready. Focus only when focus is idle on <body> (e.g. after the naming
    // dialog closed), so mounting never steals focus from another input.
    if (document.activeElement === document.body) view.focus();

    return () => {
      localViewRef.current = null;
      if (viewRef) viewRef.current = null;
      view.destroy();
    };
    // We intentionally remount on docKey change rather than diffing doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // One configuration path for Live: reconfiguring the compartment keeps the
  // cursor, scroll and undo history that a remount would lose. Runs after the
  // mount effect above on every new view (same docKey dependency).
  useEffect(() => {
    const v = viewRef?.current ?? localViewRef.current;
    if (!v) return;
    v.dispatch({
      effects: liveComp.reconfigure(
        live
          ? liveExtension({
              onLinkClick: (x) => onLinkClickRef.current?.(x),
              taskLabel: t.rd_task_toggle ?? "Toggle task",
              fmLabel:
                t.rd_frontmatter_hidden ??
                "Frontmatter hidden — edit in Properties or Source",
            })
          : [],
      ),
    });
    // Labels refresh on the next file open, not on a language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, docKey]);

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

  return (
    <div
      ref={containerRef}
      className={live ? "myco-editor live" : "myco-editor"}
    />
  );
}

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

/** `/` blocks. Unfiltered: filterSlash already matched label OR localized detail. */
function slashCompletion(t: Strings) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const m = slashQueryAt(line.text.slice(0, context.pos - line.from));
    if (!m) return null;
    return {
      from: line.from + m.from,
      filter: false,
      options: filterSlash(slashItems(t), m.query).map((i) =>
        snippetCompletion(i.template, { label: i.label, detail: i.detail }),
      ),
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

function wikilinkCompletion(
  context: CompletionContext,
): CompletionResult | null {
  // Match either after `[[` or while typing inside an unclosed `[[…`.
  const before = context.matchBefore(/\[\[([^\]\n]*)$/);
  if (!before) return null;
  if (before.from === before.to && !context.explicit) return null;
  const query = before.text.slice(2).toLowerCase();
  const tree = useVaultStore.getState().fileTree;
  const candidates = collectFiles(tree)
    .map((f) => stripExt(f.name))
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .filter((s) => s.toLowerCase().includes(query))
    .slice(0, 30);
  if (candidates.length === 0) return null;
  return {
    from: before.from + 2,
    options: candidates.map((label) => ({
      label,
      type: "text",
      apply: `${label}]]`,
    })),
    validFor: /^[^\]\n]*$/,
  };
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

function stripExt(name: string): string {
  return name.replace(/\.md$/i, "");
}
