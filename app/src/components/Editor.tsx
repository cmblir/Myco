// Editor: CodeMirror 6 with markdown language, soft wrap, and wikilink
// autocomplete. The component is uncontrolled — it owns the EditorView
// lifecycle and emits onChange on every doc change, onSave on Cmd/Ctrl-S.
// Parent passes initial value via the docKey prop to remount when switching
// files.

import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  autocompletion,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { useVaultStore } from "../stores/vaultStore";
import type { FileNode } from "../lib/ipc";

export interface EditorProps {
  docKey: string;
  initialValue: string;
  onChange?: (value: string) => void;
  onSave?: (value: string) => void;
}

export default function Editor({
  docKey,
  initialValue,
  onChange,
  onSave,
}: EditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        history(),
        keymap.of([
          {
            key: "Mod-s",
            run: (view) => {
              onSaveRef.current?.(view.state.doc.toString());
              return true;
            },
            preventDefault: true,
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
        ]),
        markdown(),
        EditorView.lineWrapping,
        autocompletion({ override: [wikilinkCompletion] }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });

    return () => {
      view.destroy();
    };
    // We intentionally remount on docKey change rather than diffing doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  return <div ref={containerRef} className="memex-editor" />;
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
