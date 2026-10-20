// The keyboard toolbar's edits (UX S51): a soft keyboard has no Tab, no ⌘B,
// no Mod-/, so a touch screen gets buttons for the commands the keys run.
// Nothing new: each tool calls a planner the keymaps already use. Pure over
// EditorState; components/EditorToolbar.tsx draws the bar.

import type { EditorState, Transaction } from "@codemirror/state";
import { undo } from "@codemirror/commands";
import { BOLD, CODE, HIGHLIGHT, ITALIC, LINK, formatTr, type Format } from "./editorFormat";
import { tabTr } from "./editorLists";
import { turnIntoTr } from "./editorBlocks";
import { moveBlockTr } from "./editorBlockOps";
import { inCode, inFrontmatter } from "./editorMarks";

export type ToolId =
  | "undo"
  | "wikilink"
  | "tag"
  | "todo"
  | "heading"
  | "outdent"
  | "indent"
  | "up"
  | "down"
  | "add"
  | "menu"
  | "hide"
  | "bold"
  | "italic"
  | "highlight"
  | "code"
  | "link";

/** Whether the bar shows: editing, over a soft keyboard (`keyboardBottom`
 *  is its height, sheetFrame's bottom). Focus set by code (a note opening)
 *  raises no keyboard on iOS; a bar there would cover the phone's bottom bar
 *  and catch its taps. */
export function toolbarShows(editing: boolean, keyboardBottom: number): boolean {
  return editing && keyboardBottom > 0;
}

/** The bar's buttons: the caret tools, or the format tools over a selection. */
export function toolsFor(selected: boolean): ToolId[] {
  return selected
    ? ["bold", "italic", "highlight", "code", "link", "hide"]
    : ["undo", "wikilink", "tag", "todo", "heading", "outdent", "indent", "up", "down", "add", "menu", "hide"];
}

const FORMATS: Partial<Record<ToolId, Format>> = {
  bold: BOLD,
  italic: ITALIC,
  highlight: HIGHLIGHT,
  code: CODE,
  link: LINK,
};

/** Text typed at a bare caret, the caret landing `at` into it. */
function typeTr(state: EditorState, text: string, at: number): Transaction | null {
  const { main } = state.selection;
  if (!main.empty || inCode(state, main.head) || inFrontmatter(state, main.head)) return null;
  return state.update({
    changes: { from: main.head, insert: text },
    selection: { anchor: main.head + at },
    scrollIntoView: true,
    userEvent: "input.type",
  });
}

/** The edit `id` makes, or null where it does nothing. `add`, `menu` and
 *  `hide` open or close things instead (the component's). */
export function toolTr(state: EditorState, id: ToolId): Transaction | null {
  const f = FORMATS[id];
  if (f) return formatTr(state, f);
  switch (id) {
    case "undo": {
      let out: Transaction | null = null;
      undo({ state, dispatch: (t) => (out = t) });
      return out;
    }
    case "wikilink":
      return typeTr(state, "[[]]", 2);
    case "tag":
      return typeTr(state, "#", 1);
    case "todo":
      return turnIntoTr(state, "- [ ] ");
    case "heading":
      // A heading already: back to text, so the button toggles.
      return turnIntoTr(state, "## ") ?? turnIntoTr(state, "");
    case "indent":
    case "outdent":
      return tabTr(state, id === "indent" ? 1 : -1);
    case "up":
    case "down":
      return moveBlockTr(state, state.selection.main.head, id === "up" ? -1 : 1);
  }
  return null;
}

/** Run `id` on the view. Mid-composition (Korean IME) nothing is sent, the
 *  one-editor rule "a write waits for compositionend": the syllable being
 *  typed is never cut. */
export function runTool(
  view: { composing: boolean; state: EditorState; dispatch: (tr: Transaction) => void },
  id: ToolId,
): boolean {
  if (view.composing) return false;
  const tr = toolTr(view.state, id);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}
