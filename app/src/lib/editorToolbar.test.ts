import { describe, expect, it, vi } from "vitest";
import { EditorState, type Transaction } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { mycoMarkdown } from "./editorBlocks";
import { runTool, toolTr, toolbarShows, toolsFor } from "./editorToolbar";

const CARET = "│";

function st(src: string, sel?: [number, number]): EditorState {
  const pos = src.indexOf(CARET);
  return EditorState.create({
    doc: src.replace(CARET, ""),
    selection: sel ? { anchor: sel[0], head: sel[1] } : { anchor: pos },
    extensions: [mycoMarkdown(), history()],
  });
}

function show(tr: Transaction | null): string | null {
  if (!tr) return null;
  const { doc, selection } = tr.state;
  const h = selection.main.head;
  return doc.sliceString(0, h) + CARET + doc.sliceString(h);
}

describe("toolsFor", () => {
  it("swaps the caret tools for the format tools while text is selected", () => {
    expect(toolsFor(false)).toEqual([
      "undo",
      "wikilink",
      "tag",
      "todo",
      "heading",
      "outdent",
      "indent",
      "up",
      "down",
      "add",
      "menu",
      "hide",
    ]);
    expect(toolsFor(true)).toEqual(["bold", "italic", "highlight", "code", "link", "hide"]);
  });
});

describe("toolTr", () => {
  it("indents and outdents a list item, the Tab a soft keyboard lacks", () => {
    expect(show(toolTr(st("- a\n- b│"), "indent"))).toBe("- a\n  - b│");
    expect(show(toolTr(st("- a\n  - b│"), "outdent"))).toBe("- a\n- b│");
  });

  it("turns the block into a to-do, and a heading back and forth", () => {
    expect(show(toolTr(st("buy│"), "todo"))).toBe("- [ ] buy│");
    expect(show(toolTr(st("Plan│"), "heading"))).toBe("## Plan│");
    expect(show(toolTr(st("## Plan│"), "heading"))).toBe("Plan│");
  });

  it("opens a link and a tag at the caret", () => {
    expect(show(toolTr(st("see │"), "wikilink"))).toBe("see [[│]]");
    expect(show(toolTr(st("see │"), "tag"))).toBe("see #│");
  });

  it("moves the block up and down", () => {
    expect(show(toolTr(st("a\n\nb│"), "up"))).toBe("b│\n\na");
    expect(toolTr(st("a│"), "down")).toBeNull();
  });

  it("formats the selection", () => {
    expect(toolTr(st("one two", [0, 3]), "bold")?.state.doc.toString()).toBe("**one** two");
  });

  it("undoes the last edit", () => {
    const s = st("a│");
    const typed = s.update({ changes: { from: 1, insert: "b" }, userEvent: "input" }).state;
    expect(toolTr(typed, "undo")?.state.doc.toString()).toBe("a");
  });
});

describe("runTool", () => {
  it("sends nothing while an IME is composing (a Korean syllable mid-way)", () => {
    const dispatch = vi.fn();
    const view = { composing: true, state: st("회의│"), dispatch };
    expect(runTool(view, "todo")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches the tool's edit otherwise", () => {
    const dispatch = vi.fn();
    const view = { composing: false, state: st("회의│"), dispatch };
    expect(runTool(view, "todo")).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("toolbarShows", () => {
  it("shows only while editing over a soft keyboard", () => {
    expect(toolbarShows(true, 300)).toBe(true);
    // Focus set by code (a note opening) raises no keyboard on iOS: the bar
    // would cover the bottom bar with nothing under it.
    expect(toolbarShows(true, 0)).toBe(false);
    expect(toolbarShows(false, 300)).toBe(false);
  });
});
