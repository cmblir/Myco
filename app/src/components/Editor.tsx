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
import type { FileNode } from "../lib/ipc";
import type { Strings } from "../lib/i18n";
import { liveExtension } from "../lib/editorLive";
import {
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
}: EditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const localViewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onLinkClickRef = useRef(onLinkClick);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onLinkClickRef.current = onLinkClick;
  // Identity token only; the same Compartment reconfigures every view we make.
  const liveComp = useRef(new Compartment()).current;

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

  return (
    <div
      ref={containerRef}
      className={live ? "myco-editor live" : "myco-editor"}
    />
  );
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

/** Frontmatter `tags:` values from the vault's indexed tags. */
function tagCompletion(context: CompletionContext): CompletionResult | null {
  const m = tagQueryAt(context.state.doc.sliceString(0, context.pos));
  if (!m) return null;
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
