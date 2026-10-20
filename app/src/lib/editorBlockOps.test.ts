import { describe, expect, it } from "vitest";
import { EditorState, type Transaction } from "@codemirror/state";
import { mycoMarkdown } from "./editorBlocks";
import {
  CODE_FENCE,
  askPrefill,
  blockActionOk,
  blockActionTr,
  blockActions,
  blockUnit,
  deleteBlockTr,
  duplicateBlockTr,
  filterActions,
  moveBlockTr,
  turnBlockTr,
} from "./editorBlockOps";
import { STRINGS } from "./i18n";

// `│` marks the caret in both the input and the expected output.
const CARET = "│";

function st(src: string): EditorState {
  const pos = src.indexOf(CARET);
  if (pos < 0) throw new Error("no caret in " + JSON.stringify(src));
  return EditorState.create({
    doc: src.replace(CARET, ""),
    selection: { anchor: pos },
    extensions: [mycoMarkdown()],
  });
}

function show(tr: Transaction | null): string | null {
  if (!tr) return null;
  const { doc, selection } = tr.state;
  const h = selection.main.head;
  return doc.sliceString(0, h) + CARET + doc.sliceString(h);
}

const at = (s: EditorState) => s.selection.main.head;
const turn = (src: string, prefix: string) => {
  const s = st(src);
  return show(turnBlockTr(s, at(s), prefix));
};
const move = (src: string, dir: 1 | -1) => {
  const s = st(src);
  return show(moveBlockTr(s, at(s), dir));
};
const dup = (src: string) => {
  const s = st(src);
  return show(duplicateBlockTr(s, at(s)));
};
const del = (src: string) => {
  const s = st(src);
  return show(deleteBlockTr(s, at(s)));
};

describe("blockUnit — what the block menu acts on", () => {
  const unit = (src: string) => {
    const s = st(src);
    const u = blockUnit(s, at(s));
    return u && [u.first, u.last, !!u.item];
  };

  it("is the blank-line separated run of lines", () => {
    expect(unit("a\n\nl1│\nl2\n\nb")).toEqual([3, 4, false]);
  });

  it("is one list item (with its children) when it has siblings", () => {
    expect(unit("- a\n  - x│\n  - y\n- b")).toEqual([2, 2, true]);
    expect(unit("- a│\n  - x\n- b")).toEqual([1, 2, true]);
    expect(unit("- only│")).toEqual([1, 1, false]);
  });

  it("is a nested item alone, never its parent's whole list", () => {
    expect(unit("- a\n  - only│\n- b")).toEqual([2, 2, true]);
  });

  it("never splits a fence at its blank lines", () => {
    expect(unit("```\nx\n│\ny\n```")).toEqual([1, 5, false]);
  });

  it("is nothing on a blank line or in frontmatter", () => {
    expect(unit("a\n│\nb")).toBeNull();
    expect(unit("---\nt│: x\n---\n\nbody")).toBeNull();
  });

  it("is a table with its ^id tag line, from either of them", () => {
    // Live draws the tag as nothing: it is the table's (decision 6).
    expect(unit("P\n\n| a |\n| - |\n| 1 |│\n\n^t\n\nQ")).toEqual([3, 7, false]);
    expect(unit("P\n\n| a |\n| - |\n| 1 |\n\n^t│\n\nQ")).toEqual([3, 7, false]);
    expect(unit("> | a |\n> | - |\n>\n> ^t│")).toEqual([1, 4, false]);
    // A tag line under no table, or a table with a paragraph under it.
    expect(unit("P\n\n^t│")).toEqual([3, 3, false]);
    expect(unit("| a |\n| - |│\n\nP")).toEqual([1, 2, false]);
  });
});

describe("a tagged table goes with its tag line", () => {
  // A chart finds its table by the tag: the menu never splits them.
  const T = "| a |\n| - |\n| 1 |";
  it("is deleted with it, from the table or the tag", () => {
    expect(del(`P\n\n${T}│\n\n^t\n\nQ`)).toBe("P\n\n│Q");
    expect(del(`P\n\n${T}\n\n^t│\n\nQ`)).toBe("P\n\n│Q");
  });
  it("moves with it, and a block moves past both", () => {
    expect(move(`P\n\n${T}│\n\n^t`, -1)).toBe(`${T}│\n\n^t\n\nP`);
    expect(move(`P\n\n${T}\n\n^t│`, -1)).toBe(`${T}\n\n^t│\n\nP`);
    expect(move(`${T}\n\n^t\n\nP│`, -1)).toBe(`P│\n\n${T}\n\n^t`);
    expect(move(`P│\n\n${T}\n\n^t`, 1)).toBe(`${T}\n\n^t\n\nP│`);
  });
  it("is duplicated with it", () => {
    expect(dup(`${T}│\n\n^t`)).toBe(`${T}\n\n^t\n\n${T}│\n\n^t`);
  });
});

describe("turnBlockTr — Turn into", () => {
  it("converts every line of a paragraph with soft lines", () => {
    expect(turn("l1│\nl2", "> ")).toBe("> l1│\n> l2");
    expect(turn("l1\n  l2│", "- ")).toBe("- l1\n- l2│");
    expect(turn("a\nb│", "1. ")).toBe("1. a\n2. b│");
    expect(turn("> a\n> b│", "")).toBe("a\nb│");
  });

  it("keeps a soft line's text that only looks like a mark", () => {
    // `2024. ` and `2) ` cannot interrupt a paragraph: they are prose.
    const date = "회의 일시\n2024. 9. 25. 오후 3시";
    expect(turn("회의 일시│\n2024. 9. 25. 오후 3시", "")).toBeNull();
    expect(turn(date + "│", "")).toBeNull();
    expect(turn("회의 일시│\n2024. 9. 25. 오후 3시", "> ")).toBe(
      "> 회의 일시│\n> 2024. 9. 25. 오후 3시",
    );
    expect(turn("Step one│\n2) next", "- ")).toBe("- Step one│\n- 2) next");
  });

  it("keeps trailing spaces (a hard break) and spaces at the caret", () => {
    expect(turn("line one  \nline two│", "> ")).toBe(
      "> line one  \n> line two│",
    );
    expect(turn("a │ b", "## ")).toBe("## a │ b");
  });

  it("makes a callout or toggle: the marker on the first line only", () => {
    expect(turn("a│\nb", "> [!note] ")).toBe("> [!note] a│\n> b");
    expect(turn("T│", "> [!note]- ")).toBe("> [!note]- T│");
    expect(turn("> [!note] T\n> body│", "")).toBe("T\nbody│");
  });

  it("wraps the paragraph in a code fence", () => {
    expect(turn("a\nb│", CODE_FENCE)).toBe("```\na\nb│\n```");
    expect(turn("## T│", CODE_FENCE)).toBe("```\nT│\n```");
  });

  it("keeps a nested item's fence in its parent item", () => {
    // A fence at column 0 would close the list and pull the indent into the code.
    expect(turn("- a\n  - x│\n- b", CODE_FENCE)).toBe(
      "- a\n  ```\n  x│\n  ```\n- b",
    );
    expect(turn("> - a\n>   - x│", CODE_FENCE)).toBe(
      "> - a\n>   ```\n>   x│\n>   ```",
    );
  });

  it("converts only a heading's own line, not the paragraph under it", () => {
    expect(turn("# T│\npara", "## ")).toBe("## T│\npara");
  });

  it("converts only the list item's own line", () => {
    expect(turn("- a\n- b│\n- c", "- [ ] ")).toBe("- a\n- [ ] b│\n- c");
    expect(turn("- a\n  - x│", "1. ")).toBe("- a\n  1. x│");
  });

  it("makes a list item's text a paragraph of its own, as Backspace does", () => {
    // Without the blank lines `b` would be a lazy line of item `a`.
    expect(turn("- a\n- b│\n- c", "")).toBe("- a\n\nb│\n\n- c");
    expect(turn("- [ ] a\n- [ ] b│", "")).toBe("- [ ] a\n\nb│");
    expect(turn("> - a\n> - b│\n> - c", "")).toBe("> - a\n>\n> b│\n>\n> - c");
    // A nested item's text stays under its parent.
    expect(turn("- a\n  - x│\n- b", "")).toBe("- a\n\n  x│\n\n- b");
  });

  it("restarts the numbered items the turned item split off", () => {
    expect(turn("1. a\n2. b│\n3. c", "- ")).toBe("1. a\n- b│\n1. c");
    expect(turn("1. a\n2. b│\n3. c\n4. d", "")).toBe(
      "1. a\n\nb│\n\n1. c\n2. d",
    );
    expect(turn("1. a\n2. b│\n3. c", "## ")).toBe("1. a\n## b│\n1. c");
  });

  it("turns a blank line into an empty block", () => {
    expect(turn("a\n\n│\n\nb", "# ")).toBe("a\n\n# │\n\nb");
  });

  it("turns a code fence back into its lines, taken as they are", () => {
    expect(turn("```\na│\nb\n```", "")).toBe("a│\nb");
    expect(turn("```\na│\nb\n```", "> ")).toBe("> a│\n> b");
    expect(turn("```js\nx│\n```", "")).toBe("x│");
    expect(turn("```\na│\nb\n```", "1. ")).toBe("1. a│\n2. b");
    // Code lines are not markdown to strip: `# x` stays.
    expect(turn("```\n# x│\n```", "- ")).toBe("- # x│");
    // One quote across a blank line; the caret on a fence goes to the text.
    expect(turn("```\na\n\nb│\n```", "> ")).toBe("> a\n>\n> b│");
    expect(turn("``│`\na\n```", "")).toBe("│a");
    expect(turn("```\na│", "")).toBe("a│");
    // Not a fence inside a quote or list item, and never Code into Code.
    expect(turn("> ```\n> a│\n> ```", "")).toBeNull();
    expect(turn("```\nx│\n```", CODE_FENCE)).toBeNull();
  });

  it("never turns a chart, diagram or query into its source as text", () => {
    // A block, not code (decision 2): its fence never becomes paragraphs.
    expect(turn("```chart\ntype: bar│\n```", "")).toBeNull();
    expect(turn("```mermaid\nx│\n```", "# ")).toBeNull();
    expect(turn("```myco-query\npath:wiki/│\n```", "")).toBeNull();
    expect(turn("``│`chart\ntype: bar\n```", "> ")).toBeNull();
  });

  it("does nothing for tables, rules, footnotes or the same kind", () => {
    expect(turn("| a │| b |\n| --- | --- |", "- ")).toBeNull();
    expect(turn("[^1]: note│", "- ")).toBeNull();
    expect(turn("## T│", "## ")).toBeNull();
  });
});

describe("moveBlockTr — Move up / Move down", () => {
  it("swaps whole blocks, keeping the blank lines between them", () => {
    expect(move("A\n\nB│", -1)).toBe("B│\n\nA");
    expect(move("A│\n\n\nB", 1)).toBe("B\n\n\nA│");
    expect(move("l1\nl2│\n\nB", 1)).toBe("B\n\nl1\nl2│");
  });

  it("moves a fence with its inner blank lines as one block", () => {
    expect(move("```\nx\n\ny\n```\n\nP│", -1)).toBe("P│\n\n```\nx\n\ny\n```");
  });

  it("moves past a whole list, not into it", () => {
    expect(move("- a\n- b\n\nP│", -1)).toBe("P│\n\n- a\n- b");
  });

  it("swaps list items with their children; numbers stay in place", () => {
    expect(move("- a\n- b│", -1)).toBe("- b│\n- a");
    expect(move("- a\n  - x\n- b│", -1)).toBe("- b│\n- a\n  - x");
    expect(move("1. a│\n2. b", 1)).toBe("1. b\n2. a│");
  });

  it("keeps the caret in the moved item's text across 9 → 10", () => {
    expect(move("9. a\n10. b│", -1)).toBe("9. b│\n10. a");
    expect(move("9. │a\n10. b", 1)).toBe("9. b\n10. │a");
    expect(move("9. a│\n10. b", 1)).toBe("9. b\n10. a│");
    // Before the number (Home) it stays at the line start.
    expect(move("9. a\n│10. b", -1)).toBe("│9. b\n10. a");
  });

  it("stops at the edges and at the frontmatter", () => {
    expect(move("A│", -1)).toBeNull();
    expect(move("A│\n\nB", -1)).toBeNull();
    expect(move("- a│\n- b", -1)).toBeNull();
    expect(move("---\nt: x\n---\n\nA│", -1)).toBeNull();
  });
});

describe("a nested item with no siblings", () => {
  // The block menu on it never deletes, copies or moves `- b` (or `- a`).
  const src = "- a\n  - only│\n- b";
  it("is deleted alone, leaving no blank line", () => {
    expect(del(src)).toBe("- a│\n- b");
  });
  it("is duplicated as its own next item", () => {
    expect(dup(src)).toBe("- a\n  - only\n  - only│\n- b");
  });
  it("does not move past its parent", () => {
    expect(move("Intro\n\n" + src, -1)).toBeNull();
    expect(move(src + "\n\nOutro", 1)).toBeNull();
  });
});

describe("duplicateBlockTr", () => {
  it("copies the block below, a blank line apart, caret in the copy", () => {
    expect(dup("A│\n\nB")).toBe("A\n\nA│\n\nB");
    expect(dup("l1\nl│2")).toBe("l1\nl2\n\nl1\nl│2");
  });

  it("copies a list item as the next item and renumbers", () => {
    expect(dup("- a│\n- b")).toBe("- a\n- a│\n- b");
    expect(dup("1. a│\n2. b")).toBe("1. a\n2. a│\n3. b");
  });
});

describe("deleteBlockTr", () => {
  it("removes the block and one gap; the caret goes to the next block", () => {
    expect(del("A\n\nB│\n\nC")).toBe("A\n\n│C");
    expect(del("A\n\nB│")).toBe("A│");
    expect(del("B│")).toBe("│");
  });

  it("removes a list item and renumbers the rest", () => {
    expect(del("1. a\n2. b│\n3. c")).toBe("1. a\n│2. c");
    expect(del("- a\n- b│")).toBe("- a│");
  });

  it("keeps a numbered list's start when its first item goes", () => {
    expect(del("1. a│\n2. b\n3. c")).toBe("│1. b\n2. c");
    expect(del("5. a│\n6. b")).toBe("│5. b");
    expect(del("> 1. a│\n> 2. b")).toBe("│> 1. b");
  });

  it("never touches the frontmatter", () => {
    expect(del("---\nt: x\n---\n\nA│")).toBe("---\nt: x\n---\n\n│");
  });
});

describe("askPrefill — Ask about this block", () => {
  const ask = (src: string) => {
    const s = st(src);
    return askPrefill(s, at(s));
  };

  it("takes the block's text past its marks; the answer goes after the block", () => {
    expect(ask("## Title│\n\npara")).toEqual({ question: "Title", pos: 8 });
    expect(ask("- a\n- b│\n- c")).toEqual({ question: "b", pos: 7 });
    expect(ask("> quoted │text")).toEqual({ question: "quoted text", pos: 13 });
    expect(ask("- [ ] to│do")).toEqual({ question: "todo", pos: 10 });
  });

  it("joins a paragraph's soft lines; a heading's paragraph is not the heading", () => {
    expect(ask("line one\nline two│")).toEqual({
      question: "line one line two",
      pos: 17,
    });
    // The heading and its paragraph are one block: the answer goes after both.
    expect(ask("# T│\npara")).toEqual({ question: "T", pos: 8 });
  });

  it("asks a callout's title line only, from any of its lines", () => {
    expect(ask("> [!note] T│\n> body")).toEqual({ question: "T", pos: 18 });
    expect(ask("> [!tip]- T\n> bo│dy")).toEqual({ question: "T", pos: 18 });
    // The callout is the block: its title from an item in it, its end.
    expect(ask("> [!note]- T\n> - a│\n> - b\n\nafter")).toEqual({
      question: "T",
      pos: 24,
    });
    // A callout in a list item, read as Live reads it: not its `[!tip]`.
    expect(ask("- > [!tip] Tip│ title\n  > body")).toEqual({
      question: "Tip title",
      pos: 29,
    });
  });

  it("is off on an empty block, a blank line, fenced code and frontmatter", () => {
    expect(ask("- │")).toBeNull();
    expect(ask("## │")).toBeNull();
    expect(ask("a\n│\nb")).toBeNull();
    expect(ask("```\ncode│\n```")).toBeNull();
    expect(ask("---\nt│: x\n---\n\nbody")).toBeNull();
  });
});

describe("blockActions / filterActions", () => {
  const ko = blockActions(STRINGS.ko);
  const ids = (q: string) => filterActions(ko, q).map((a) => a.id);

  it("offers Turn into (Text … Code) then the block actions", () => {
    expect(ko.map((a) => a.id)).toEqual([
      "text",
      "h1",
      "h2",
      "h3",
      "h4",
      "bullet",
      "numbered",
      "todo",
      "quote",
      "callout",
      "toggle",
      "code",
      "duplicate",
      "delete",
      "up",
      "down",
      "ask",
    ]);
    expect(ko[0].label).toBe("텍스트");
    expect(ko[16].label).toBe("이 블록으로 질문하기");
  });

  it("filters by keyword, alias, localized name or the Korean layout", () => {
    expect(ids("dup")).toEqual(["duplicate"]);
    expect(ids("복제")).toEqual(["duplicate"]);
    expect(ids("ㅗ2")).toEqual(["h2"]);
    expect(ids("d")[0]).toBe("duplicate");
    expect(ids("질문")).toEqual(["ask"]);
    expect(ids("ask")).toEqual(["ask"]);
    expect(ids("zzz")).toEqual([]);
  });

  it("runs an action, or returns null when it cannot apply", () => {
    const s = st("para│\n\nnext");
    const by = (id: string) => ko.find((a) => a.id === id)!;
    expect(show(blockActionTr(s, at(s), by("h1")))).toBe("# para│\n\nnext");
    expect(show(blockActionTr(s, at(s), by("down")))).toBe("next\n\npara│");
    expect(blockActionTr(s, at(s), by("up"))).toBeNull();
    expect(blockActionTr(s, at(s), by("text"))).toBeNull();
  });

  it("on touch, indents and outdents a list item (no Tab key there)", () => {
    const touch = blockActions(STRINGS.ko, { nest: true });
    const by = (id: string) => touch.find((a) => a.id === id)!;
    expect(touch.map((a) => a.id).slice(14, 18)).toEqual([
      "up",
      "down",
      "indent",
      "outdent",
    ]);
    expect(by("indent").label).toBe("들여쓰기");
    const s = st("- a\n- b│");
    expect(show(blockActionTr(s, at(s), by("indent")))).toBe("- a\n  - b│");
    expect(blockActionTr(s, at(s), by("outdent"))).toBeNull();
    const nested = st("- a\n  - b│");
    expect(show(blockActionTr(nested, at(nested), by("outdent")))).toBe(
      "- a\n- b│",
    );
    const para = st("para│");
    expect(blockActionTr(para, at(para), by("indent"))).toBeNull();
  });

  it("ask applies where askPrefill has a question; it makes no transaction", () => {
    const by = (id: string) => ko.find((a) => a.id === id)!;
    const s = st("para│\n\nnext");
    expect(blockActionOk(s, at(s), by("ask"))).toBe(true);
    expect(blockActionOk(s, at(s), by("up"))).toBe(false);
    expect(blockActionTr(s, at(s), by("ask"))).toBeNull();
    const empty = st("- │");
    expect(blockActionOk(empty, at(empty), by("ask"))).toBe(false);
  });
});
