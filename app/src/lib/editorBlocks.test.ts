import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  EditorSelection,
  EditorState,
  type Transaction,
} from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import {
  applySlash,
  backspaceTr,
  bodyStart,
  deleteTr,
  enterTr,
  inputRuleTr,
  isGapLine,
  liveEditing,
  mycoMarkdown,
  shiftEnterTr,
  tabKey,
  TURN_INTO,
  turnIntoTr,
  verticalStop,
} from "./editorBlocks";
import { tabTr } from "./editorLists";
import { hiddenRuns, prefixEnd } from "./editorMarks";
import { slashItems } from "./editorCompletions";
import { insertBlockTr } from "./editorRecall";
import { STRINGS } from "./i18n";
import { markdownRenderer } from "./markdown";
import { calloutBlocks } from "./blocks/calloutLive";
import { openBlockEditor } from "./blocks/live";
import { TABLE } from "./blocks/table";

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

/** A selection: `‹` anchor, `›` head. */
function sel(src: string, extra: unknown[] = []): EditorState {
  const a = src.indexOf("‹");
  const plain = src.replace("‹", "");
  const h = plain.indexOf("›");
  return EditorState.create({
    doc: plain.replace("›", ""),
    selection: EditorSelection.single(a, h),
    extensions: [mycoMarkdown(), ...(extra as [])],
  });
}

const enter = (src: string) => show(enterTr(st(src)));
const del = (src: string) => show(deleteTr(st(src)));
const shiftEnter = (src: string) => show(shiftEnterTr(st(src)));
const backspace = (src: string) => show(backspaceTr(st(src)));
const tab = (src: string, dir: 1 | -1 = 1) => show(tabTr(st(src), dir));
const typed = (src: string, text: string) => {
  const s = st(src);
  const pos = s.selection.main.head;
  return show(inputRuleTr(s, pos, pos, text));
};

/** The note's top-level blocks, from a finished parse (the view finishes
 *  one the 20 ms first parse left short in idle time). */
function topBlocks(state: EditorState): string[] {
  const out: string[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, Infinity)!;
  for (let n = tree.topNode.firstChild; n; n = n.nextSibling) out.push(n.name);
  return out;
}

describe("setext headings are off", () => {
  it("never turns the paragraph above into a heading", () => {
    // A loaded full run can cut CodeMirror's 20 ms parse short; a clock that
    // leaps makes that happen every time.
    let t = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
    onTestFinished(() => clock.mockRestore());
    // The owner's report: `=` under a paragraph blew its font up to H1 size.
    for (const under of ["=", "-", "- ", "==="]) {
      const s = EditorState.create({
        doc: "저희는 기획 중입니다!\n" + under,
        extensions: [mycoMarkdown()],
      });
      expect(topBlocks(s)).not.toContain("SetextHeading1");
      expect(topBlocks(s)).not.toContain("SetextHeading2");
    }
    const hr = EditorState.create({
      doc: "para\n---",
      extensions: [mycoMarkdown()],
    });
    expect(topBlocks(hr)).toEqual(["Paragraph", "HorizontalRule"]);
  });
});

describe("enterTr — Enter starts a new block", () => {
  it("ends a paragraph or heading with a blank line", () => {
    expect(enter("para│")).toBe("para\n\n│");
    expect(enter("## Title│")).toBe("## Title\n\n│");
  });

  it("splits mid-block; the tail becomes a plain paragraph", () => {
    expect(enter("ab│cd")).toBe("ab\n\n│cd");
    expect(enter("## ab│ cd")).toBe("## ab\n\n│cd");
  });

  it("keeps the new block apart from a soft-broken line below", () => {
    expect(enter("l1│\nl2")).toBe("l1\n\n│\n\nl2");
    expect(enter("l1│\n\nl2")).toBe("l1\n\n│\n\nl2");
  });

  it("at a block's start pushes it down and keeps the caret with it", () => {
    expect(enter("para\n\n## │T")).toBe("para\n\n\n## │T");
    expect(enter("a\n│b")).toBe("a\n\n\n│b");
  });

  it("the `=` from the report: Enter then `=` stays a paragraph", () => {
    const tr = enterTr(st("저희는 기획 중입니다!│"));
    const next = tr!.state.update({
      changes: { from: tr!.state.selection.main.head, insert: "=" },
    }).state;
    expect(topBlocks(next)).toEqual(["Paragraph", "Paragraph"]);
  });

  it("continues list items and to-dos", () => {
    expect(enter("- a│")).toBe("- a\n- │");
    expect(enter("1. a│")).toBe("1. a\n2. │");
    expect(enter("- [ ] a│")).toBe("- [ ] a\n- [ ] │");
  });

  it("leaves a list from an empty item in one press, set apart", () => {
    expect(enter("- a\n- │")).toBe("- a\n\n│");
    expect(enter("- [ ] a\n- [ ] │")).toBe("- [ ] a\n\n│");
    expect(enter("1. a\n2. │")).toBe("1. a\n\n│");
    expect(enter("- a\n- │\n- c")).toBe("- a\n\n│\n\n- c");
  });

  it("an empty nested item steps out one level", () => {
    expect(enter("- a\n  - │")).toBe("- a\n- │");
  });

  it("opens the next item from a continuation line (after Shift-Enter)", () => {
    expect(enter("- a\n  cont│")).toBe("- a\n  cont\n- │");
    expect(enter("- [ ] a\n      cont│")).toBe("- [ ] a\n      cont\n- [ ] │");
    expect(enter("1. a\n   cont│")).toBe("1. a\n   cont\n2. │");
    expect(enter("- a\n  │")).toBe("- a\n- │");
  });

  it("at an item's text start pushes an empty item of the same kind above", () => {
    expect(enter("- a\n- │b")).toBe("- a\n- \n- │b");
    expect(enter("- [x] │a")).toBe("- [ ] \n- [x] │a");
    expect(enter("1. a\n2. │b\n3. c")).toBe("1. a\n2. \n3. │b\n4. c");
  });

  it("an empty marker the parser reads as text still exits or steps out", () => {
    expect(enter("text\n- │")).toBe("text\n\n│");
    expect(enter("- a\n  1. │")).toBe("- a\n- │");
  });

  it("never turns a blank line inside code into a list item", () => {
    expect(enter("- a\n  ```\n  x\n  │\n  ```")).toBeNull();
  });

  it("an empty marker typed in a quote exits, leaving no stray dash", () => {
    expect(enter("> text\n> -│")).toBe("> text\n\n│");
  });

  it("a blank continuation in a quoted list opens the next item", () => {
    expect(enter("> - a\n>   │")).toBe("> - a\n> - │");
  });

  it("at column 0 of an item keeps the caret with the item", () => {
    expect(enter("- a\n│- b")).toBe("- a\n- \n- │b");
    expect(enter("1. a\n│2. b\n3. c")).toBe("1. a\n2. \n3. │b\n4. c");
    expect(enter("1. a\n   │1. b")).toBe("1. a\n   1. \n   2. │b");
  });

  it("an empty heading or quote inside an item leaves the block in one press", () => {
    expect(enter("문단\n\n## │")).toBe("문단\n\n│");
    expect(enter("- a\n- > │")).toBe("- a\n\n│");
  });

  it("replaces a selection and then starts a new block", () => {
    expect(show(enterTr(sel("하나‹둘셋›넷")))).toBe("하나\n\n│넷");
  });

  it("inside a table adds a row instead of breaking it", () => {
    const t = "| a | b |\n| - | - |\n| c | d |\n| e | f |";
    expect(enter(t.replace("| c | d |", "| c | d |│"))).toBe(
      "| a | b |\n| - | - |\n| c | d |\n| │| |\n| e | f |",
    );
    expect(enter(t.replace("| a | b |", "| a | b |│"))).toBe(
      "| a | b |\n| - | - |\n| │| |\n| c | d |\n| e | f |",
    );
  });

  it("splitting inside bold or a link keeps both halves valid", () => {
    expect(enter("some **bold │text** here")).toBe(
      "some **bold**\n\n**│text** here",
    );
    expect(enter("a ==high │light== b")).toBe("a ==high==\n\n==│light== b");
    expect(enter("see [the │docs](https://x.y) now")).toBe(
      "see [the docs](https://x.y)\n\n│now",
    );
  });

  it("splits bold whole past where the state's first parse stopped", () => {
    // A state parses only its first 3000 chars up front.
    const intro = "Filler paragraph text.\n\n".repeat(150);
    expect(enter(intro + "some **bold │text** here")).toBe(
      intro + "some **bold**\n\n**│text** here",
    );
  });

  it("leaving an ordered list mid-way restarts the rest at 1", () => {
    expect(enter("1. a\n2. │\n3. c\n4. d")).toBe("1. a\n\n│\n\n1. c\n2. d");
  });

  it("leaves a quote in one press", () => {
    expect(enter("> a│")).toBe("> a\n\n│");
    expect(enter("> a\n> │")).toBe("> a\n\n│");
  });

  it("from a callout's or toggle's title starts its first body line, inside", () => {
    expect(enter("> [!tip] Title│")).toBe("> [!tip] Title\n> │");
    expect(enter("> [!note]- T│")).toBe("> [!note]- T\n> │");
    // A body below stays attached, a paragraph of its own (a bare `> ` line
    // would join it: `x body` in Preview).
    expect(enter("> [!tip] Title│\n> body")).toBe(
      "> [!tip] Title\n> │\n>\n> body",
    );
    expect(enter("> [!tip] Ti│tle\n> body")).toBe(
      "> [!tip] Ti\n> │tle\n>\n> body",
    );
    expect(enter("> [!tip] T│\n>\n> body")).toBe("> [!tip] T\n> │\n>\n> body");
    // Nested, and in a list item: the new line keeps the containers.
    expect(enter("> > [!note] T│")).toBe("> > [!note] T\n> > │");
    expect(enter("- > [!note] T│")).toBe("- > [!note] T\n  > │");
    expect(enter("- a\n  > [!note] T│\n  > b")).toBe(
      "- a\n  > [!note] T\n  > │\n  >\n  > b",
    );
    // Before the title's text the callout moves down, as any block does.
    expect(enter("para\n\n> [!tip] │T")).toBe("para\n\n\n> [!tip] │T");
  });

  it("from a callout's body line starts a new paragraph in the callout", () => {
    expect(enter("> [!tip] T\n> body│")).toBe("> [!tip] T\n> body\n>\n> │");
    expect(enter("> [!tip] T\n> one│\n> two")).toBe(
      "> [!tip] T\n> one\n>\n> │\n>\n> two",
    );
    expect(enter("> [!tip] T\n> ab│cd")).toBe("> [!tip] T\n> ab\n>\n> │cd");
    expect(enter("> [!tip] T\n> a\n> │b")).toBe("> [!tip] T\n> a\n>\n> │b");
    // An empty body line leaves it, the `>` gap above going too.
    expect(enter("> [!tip] T\n> a\n>\n> │")).toBe("> [!tip] T\n> a\n\n│");
    expect(enter("> [!tip] T\n> a\n> │")).toBe("> [!tip] T\n> a\n\n│");
    // A plain quote is left as before.
    expect(enter("> a│\n> b")).toBe("> a\n\n│\n\n> b");
  });

  it("from a folded toggle's title opens a block after the whole toggle", () => {
    const live = (src: string) => {
      const pos = src.indexOf(CARET);
      return show(
        enterTr(
          EditorState.create({
            doc: src.replace(CARET, ""),
            selection: { anchor: pos },
            extensions: [mycoMarkdown(), calloutBlocks()],
          }),
        ),
      );
    };
    expect(live("> [!note]- Folded│\n> one\n> two\n\nafter")).toBe(
      "> [!note]- Folded\n> one\n> two\n\n│\n\nafter",
    );
    expect(live("> [!note]- F│\n> b")).toBe("> [!note]- F\n> b\n\n│");
    expect(live("> > [!note]- F│\n> > b")).toBe(
      "> > [!note]- F\n> > b\n>\n> │",
    );
    // Open (`+`), or with no body to hide: into the body.
    expect(live("> [!note]+ F│\n> b")).toBe("> [!note]+ F\n> │\n>\n> b");
    expect(live("> [!note]- F│")).toBe("> [!note]- F\n> │");
  });

  it("closes an open code fence and puts the caret inside", () => {
    expect(enter("```js│")).toBe("```js\n│\n```");
    expect(enter("para\n\n```│")).toBe("para\n\n```\n│\n```");
  });

  it("inside a $$ block breaks the line and keeps its container", () => {
    expect(enter("> [!note] Sum\n> $$\n> x│\n> $$")).toBe(
      "> [!note] Sum\n> $$\n> x\n> │\n> $$",
    );
    expect(enter("- item\n\n  $$\n  x│\n  $$")).toBe(
      "- item\n\n  $$\n  x\n  │\n  $$",
    );
    expect(enter("- $$│\n  x\n  $$")).toBe("- $$\n  │\n  x\n  $$");
    expect(enter("> - $$│\n>   x\n>   $$")).toBe(
      "> - $$\n>   │\n>   x\n>   $$",
    );
    expect(enter("$$\nx│\n$$")).toBe("$$\nx\n│\n$$");
    // Past a bare `$$` just typed (still unclosed): into the block, no blank.
    expect(enter("Typed:\n\n$$│")).toBe("Typed:\n\n$$\n│");
    expect(enter("> $$│")).toBe("> $$\n> │");
    expect(enter("- $$│")).toBe("- $$\n  │");
    // Inside a one-line formula: two lines of one block.
    expect(enter("- $$x│y$$")).toBe("- $$x\n  │y$$");
  });

  it("after a one-line $$…$$ item continues the list", () => {
    expect(enter("- $$x$$│")).toBe("- $$x$$\n- │");
    expect(enter("1. $$a$$│")).toBe("1. $$a$$\n2. │");
    expect(enter("> [!tip] T\n> $$a$$│")).toBe("> [!tip] T\n> $$a$$\n>\n> │");
  });

  it("leaves code, frontmatter and blank lines to the default newline", () => {
    expect(enter("```\na│\n```")).toBeNull();
    expect(enter("```│\nx\n```")).toBeNull();
    expect(enter("---\na: 1│\n---\nbody")).toBeNull();
    expect(enter("para\n\n│")).toBeNull();
  });

  it("leaves a table only from the end of its last row", () => {
    expect(enter("| a |\n| - |\n| b |│")).toBe("| a |\n| - |\n| b |\n\n│");
    expect(enter("| a |│\n| - |\n| b |")).toBe("| a |\n| - |\n| │|\n| b |");
  });
});

describe("shiftEnterTr — a line break inside the block", () => {
  it("breaks a paragraph without starting a block", () => {
    expect(shiftEnter("para│")).toBe("para\n│");
  });

  it("indents under a list item and keeps a quote's marker", () => {
    expect(shiftEnter("- a│")).toBe("- a\n  │");
    expect(shiftEnter("1. a│")).toBe("1. a\n   │");
    expect(shiftEnter("> a│")).toBe("> a\n> │");
  });
});

describe("backspaceTr — Backspace at a block's start", () => {
  it("turns a heading back into a paragraph, never joining lines", () => {
    // The owner's report: this used to leave `Intro paragraph## Title`.
    expect(backspace("para\n\n## │T")).toBe("para\n\n│T");
    expect(backspace("a\n## │T\nb")).toBe("a\n\n│T\n\nb");
  });

  it("turns a top-level list item, to-do or quote into a paragraph", () => {
    expect(backspace("- a\n- │b\n- c")).toBe("- a\n\n│b\n\n- c");
    expect(backspace("- [ ] │t")).toBe("│t");
    expect(backspace("> │q")).toBe("│q");
  });

  it("at a callout's tag turns the whole callout into text, tag and all", () => {
    // As Cmd+Opt+0 does: never `[!tip] Title` left in the prose.
    expect(backspace("above\n\n> │[!tip] Title\n> body")).toBe(
      "above\n\n│Title\nbody",
    );
    expect(backspace("> │[!note]- T\n> a\n>\n> b\nlazy")).toBe(
      "│T\na\n\nb\nlazy",
    );
    // One level out: the containers around it stay.
    expect(backspace("> > │[!tip] T\n> > b")).toBe("> │T\n> b");
    expect(backspace("- > │[!tip] T\n  > b")).toBe("- │T\n  b");
  });

  it("outdents a nested item first", () => {
    expect(backspace("- a\n  - │b")).toBe("- a\n- │b");
  });

  it("merges a paragraph into the block above across blank lines", () => {
    expect(backspace("para1\n\n│para2")).toBe("para1│para2");
    expect(backspace("## T\n\n│p")).toBe("## T│p");
  });

  it("drops only the innermost mark inside a quote", () => {
    expect(backspace("> - a\n> - │b\n> - c")).toBe("> - a\n>\n> │b\n>\n> - c");
    expect(backspace("> a\n> > │b")).toBe("> a\n> │b");
  });

  it("takes back a quote's soft line break", () => {
    expect(backspace("> a\n> │b")).toBe("> a│b");
  });

  it("restarts the ordered items after a dropped one at 1", () => {
    expect(backspace("1. │a\n2. b\n3. c")).toBe("│a\n\n1. b\n2. c");
  });

  it("outdents a nested item inside a quote", () => {
    expect(backspace("> - a\n>   - │b")).toBe("> - a\n> - │b");
  });

  it("never glues a divider, table or footnote definition onto a paragraph", () => {
    // Consumed with no change: the default would delete the separating blank.
    expect(backspace("para\n\n│---\n\nafter")).toBe("para\n\n│---\n\nafter");
    expect(backspace("para\n\n│| a | b |\n| - | - |\n| c | d |")).toBe(
      "para\n\n│| a | b |\n| - | - |\n| c | d |",
    );
    expect(backspace("para\n\n│[^src-a]: raw/a.md")).toBe(
      "para\n\n│[^src-a]: raw/a.md",
    );
    expect(backspace("para\n\n│[^1]: Smith 2020, p. 4.")).toBe(
      "para\n\n│[^1]: Smith 2020, p. 4.",
    );
    // A spare blank line may still go.
    expect(backspace("para\n\n\n│---")).toBeNull();
  });

  it("never glues onto or into an image or note embed Live draws as a block", () => {
    for (const blockLine of ["![[Welcome#Intro]]", "![a](assets/x.png)"]) {
      for (const src of [
        `${blockLine}\n\n│text`,
        `para\n\n│${blockLine}`,
        `- a\n\n  ${blockLine}\n\n│text`,
      ])
        expect(backspace(src), src).toBe(src);
    }
    // An image inside text is prose.
    expect(backspace("para\n\n│see ![a](x.png) here")).toBe(
      "para│see ![a](x.png) here",
    );
  });

  it("never glues a paragraph onto a closing fence, divider or frontmatter", () => {
    expect(backspace("```\ncode\n```\n│text")).toBe("```\ncode\n```\n│text");
    expect(backspace("---\na: 1\n---\n│# T")).toBe("---\na: 1\n---\n│# T");
    expect(backspace("---\na: 1\n---\n\n│# T")).toBe("---\na: 1\n---\n│# T");
  });

  it("at column 0 before a visible number drops the item, not joins it", () => {
    expect(backspace("1. a\n│2. b")).toBe("1. a\n\n│b");
  });

  it("drops only the heading mark inside a list item", () => {
    expect(backspace("- a\n- # │h\n- b")).toBe("- a\n- │h\n- b");
  });

  it("on an empty line takes the line out, one press per Enter", () => {
    // The owner's report: Backspace on a new empty line did nothing.
    expect(backspace("para\n\n│")).toBe("para│");
    expect(backspace("para\n│")).toBe("para│");
    expect(backspace("- item\n\n│")).toBe("- item│");
    expect(backspace("## T\n\n│")).toBe("## T│");
  });

  it("on an empty line between blocks keeps one blank line between them", () => {
    expect(backspace("para\n\n│\n\nnext")).toBe("para│\n\nnext");
    expect(backspace("para\n\n\n│\nnext")).toBe("para\n\n│\nnext");
    // The only blank line between two blocks stays; the caret goes up.
    expect(backspace("para\n│\nnext")).toBe("para│\n\nnext");
  });

  it("undoes Enters one at a time, never deleting text", () => {
    let s = st("문단\n\n\n\n│");
    for (let i = 0; i < 3; i++) s = backspaceTr(s)!.state;
    expect(s.doc.toString()).toBe("문단");
    expect(s.selection.main.head).toBe(2);
  });

  it("after a widget block takes the blank line out and selects the block", () => {
    // The caret lands at the end of the block's last line, where ArrowUp
    // lands too: Live's snap selects the block whole there (blocks/live).
    expect(backspace("![[pic.png|120]]\n\n│")).toBe("![[pic.png|120]]│");
    expect(backspace("![alt](assets/a.png)\n\n│")).toBe(
      "![alt](assets/a.png)│",
    );
    expect(backspace("![[note#Heading]]\n\n│")).toBe("![[note#Heading]]│");
    expect(backspace("| a |\n| - |\n| 1 |\n\n│")).toBe("| a |\n| - |\n| 1 |│");
    expect(backspace("> [!note] T\n> body\n\n│")).toBe("> [!note] T\n> body│");
    // A registry fence (toc) is a widget, not code: its closing fence's end.
    expect(backspace("```toc\n```\n\n│")).toBe("```toc\n```│");
    // Text below: the one blank line between them stays, the caret steps up.
    expect(backspace("![[pic.png]]\n│\npara")).toBe("![[pic.png]]│\n\npara");
  });

  it("after a table or definition moves into it; after code, onto the line below", () => {
    expect(backspace("| a |\n| - |\n\n│")).toBe("| a |\n| - |│");
    expect(backspace("[^a]: def\n\n│")).toBe("[^a]: def│");
    expect(backspace("```\nx\n```\n\n│")).toBe("```\nx│\n```");
    expect(backspace("a\n\n---\n\n│")).toBe("a\n\n---\n│");
    expect(backspace("---\na: 1\n---\n\n│")).toBe("---\na: 1\n---\n│");
  });

  it("leaves everything else to the default delete", () => {
    expect(backspace("```\nx\n```\n\n│p")).toBe("```\nx\n```\n\n│p");
    expect(backspace("l1\n│l2")).toBeNull();
    expect(backspace("│para")).toBeNull();
    expect(backspace("## T│x")).toBeNull();
  });
});

describe("isGapLine — the blank lines Live draws short", () => {
  const gap = (src: string, n: number) => isGapLine(st(src + CARET), n);
  it("is a blank line outside code and frontmatter", () => {
    expect(gap("a\n\nb", 2)).toBe(true);
    expect(gap("a\n  \nb", 2)).toBe(true);
    expect(gap("a\n\nb", 1)).toBe(false);
    expect(gap("a\n\nb", 3)).toBe(false);
    expect(gap("- a\n\n- b", 2)).toBe(true);
    expect(gap("a\n\n\n", 4)).toBe(true);
  });
  it("is not a blank line inside a fence, indented code or frontmatter", () => {
    expect(gap("```\n\nx\n```", 2)).toBe(false);
    expect(gap("```\n\n```", 2)).toBe(false);
    expect(gap("    a\n\n    b", 2)).toBe(false);
    expect(gap("---\na: 1\n\n---\n\nb", 3)).toBe(false);
    expect(gap("---\na: 1\n---\n\nb", 4)).toBe(true);
  });
  it("is a bare `>` between two passages of a quote, drawn short too", () => {
    expect(gap("> [!question] Q\n> a\n>\n> b", 3)).toBe(true);
    expect(gap("> a\n> \n> b", 2)).toBe(true);
    // A quote's last line is not between passages.
    expect(gap("> a\n>", 2)).toBe(false);
  });
});

describe("verticalStop — where ArrowUp/Down ends once CM's move lands", () => {
  // CM's move put the head at the start of line `n`.
  const stop = (src: string, n: number, forward: boolean) => {
    const s = st(src + CARET);
    return verticalStop(s, s.doc.line(n).from, forward);
  };
  it("keeps a line that is not a gap", () => {
    expect(stop("a\n\nb", 1, false)).toBe(1);
    expect(stop("a\n\nb", 3, true)).toBe(3);
  });
  it("leaves a gap run by line number, to the first line past it", () => {
    expect(stop("a\n\nb", 2, false)).toBe(1);
    expect(stop("a\n\nb", 2, true)).toBe(3);
    expect(stop("a\n\n\n\nb", 3, false)).toBe(1);
    expect(stop("a\n\n\n\nb", 3, true)).toBe(5);
  });
  it("stops on a closed fence's short end line, as ArrowDown reaches it", () => {
    // The review's report: CM's half-line step from the gap overshot the
    // 7px end line and put the caret in the code.
    expect(stop("```js\nconst a = 1\n```\n\nafter", 4, false)).toBe(3);
    const nested = "> ```js\n> code\n>\n> ```\n\n- ```py\n  x\n\n  ```\n\nend";
    expect(stop(nested, 5, false)).toBe(4);
    expect(stop(nested, 10, false)).toBe(9);
    expect(stop("p1\n\n```js\ncode\n\n```\n\np2", 7, false)).toBe(6);
  });
  it("stops on the note's first or last line, gap or not", () => {
    expect(stop("\n\na", 2, false)).toBe(1);
    expect(stop("a\n\n\n", 3, true)).toBe(4);
  });
  it("never goes into the hidden frontmatter", () => {
    // The review's report: two ArrowUps from a new note's last line put the
    // caret at 0, where Delete wiped the properties and Enter pushed them
    // off line 1. The line after the frontmatter is the note's first.
    const fm = "---\na: 1\n---\n\n# H\n";
    expect(stop(fm, 4, false)).toBe(4);
    expect(stop("---\na: 1\n---\n\n\n# H", 5, false)).toBe(4);
    // CM's move landed inside it: none, the key holds the caret.
    expect(verticalStop(st(fm + CARET), 0, false)).toBeNull();
  });
});

describe("deleteTr — forward Delete at a block's end", () => {
  it("merges the next prose block's text, dropping its marks", () => {
    expect(del("문단│\n\n## 제목")).toBe("문단│제목");
    expect(del("- a│\n- b")).toBe("- a│b");
  });

  it("never pulls a callout's title up: its `[!type]` would leak into the text", () => {
    for (const src of [
      "para│\n\n> [!tip] Title\n> body",
      "para│\n\n> [!note]- Toggle\n> body",
      "- a│\n- > [!tip] T",
    ])
      expect(del(src)).toBe(src);
    // A plain quote's first line still merges.
    expect(del("para│\n\n> q")).toBe("para│q");
  });

  it("never pulls an image or note embed block up, nor text into one", () => {
    for (const blockLine of ["![[Welcome#Intro]]", "![a](assets/x.png)"]) {
      for (const src of [
        `para│\n\n${blockLine}`,
        `${blockLine}│\n\ntext`,
        `> ${blockLine}│\n>\n> text`,
      ])
        expect(del(src), src).toBe(src);
    }
    expect(del("para│\n\nsee ![a](x.png)")).toBe("para│see ![a](x.png)");
  });

  it("joins a quote's soft line without its quote mark", () => {
    expect(del("> a│\n> b")).toBe("> a│b");
    expect(del("> - a│\n>   b")).toBe("> - a│b");
    expect(del("> [!tip] T│\n> body")).toBe("> [!tip] T│body");
  });

  it("holds at a folded toggle's title end: its body is out of sight", () => {
    const src = "> [!note]- Toggle│\n> hidden body\n\nafter";
    const pos = src.indexOf(CARET);
    const s = EditorState.create({
      doc: src.replace(CARET, ""),
      selection: { anchor: pos },
      extensions: [mycoMarkdown(), calloutBlocks()],
    });
    expect(show(deleteTr(s))).toBe(src);
  });

  it("never pulls a fence, divider or table up; leaves soft lines to the default", () => {
    expect(del("문단│\n\n```py\nx\n```")).toBe("문단│\n\n```py\nx\n```");
    expect(del("문단│\n\n---")).toBe("문단│\n\n---");
    expect(del("l1│\nl2")).toBeNull();
  });
});

describe("tabTr — Tab nests list items", () => {
  it("nests under the previous sibling, by its content width", () => {
    expect(tab("- a\n- │b")).toBe("- a\n  - │b");
    expect(tab("- a\n- │b\n  - c")).toBe("- a\n  - │b\n    - c");
  });

  it("restarts a new ordered sublist at 1 and renumbers the rest", () => {
    expect(tab("1. a\n2. │b")).toBe("1. a\n   1. │b");
    expect(tab("1. a\n2. │b\n3. c")).toBe("1. a\n   1. │b\n2. c");
  });

  it("Shift-Tab lifts a nested item back to its parent's level", () => {
    expect(tab("- a\n  - │b", -1)).toBe("- a\n- │b");
    expect(tab("1. a\n   1. │b\n2. c", -1)).toBe("1. a\n2. │b\n3. c");
    // Siblings left behind hang under the lifted item and restart at 1.
    expect(tab("1. a\n   1. │x\n   2. y\n2. b", -1)).toBe(
      "1. a\n2. │x\n   1. y\n3. b",
    );
  });

  it("nests and lifts lists inside a quote", () => {
    expect(tab("> - a\n> - │b")).toBe("> - a\n>   - │b");
    expect(tab("> - a\n>   - │b", -1)).toBe("> - a\n> - │b");
  });

  it("moves an item's child quote with it", () => {
    expect(tab("- a\n- │b\n  > q")).toBe("- a\n  - │b\n    > q");
  });

  it("nests or lifts every selected item together", () => {
    expect(show(tabTr(sel("- a\n- ‹b\n- c›"), 1))).toBe("- a\n  - b\n  - c│");
    expect(show(tabTr(sel("- a\n  - ‹b\n  - c›"), -1))).toBe("- a\n- b\n- c│");
  });

  it("nests every selected item past where the first parse stopped", () => {
    const intro = "Filler paragraph text.\n\n".repeat(150);
    expect(show(tabTr(sel(intro + "- a\n- ‹b\n- c›"), 1))).toBe(
      intro + "- a\n  - b\n  - c│",
    );
  });

  it("lifts a tab-indented item inside a quote", () => {
    expect(tab("> - a\n> \t- │b", -1)).toBe("> - a\n> - │b");
  });

  it("nests tab-indented lists by column", () => {
    expect(tab("- x\n\t- a\n\t- │b")).toBe("- x\n\t- a\n\t  - │b");
    expect(tab("- x\n\t- a\n\t\t- │b", -1)).toBe("- x\n\t- a\n\t- │b");
  });

  it("is a no-op for the first item and outside lists", () => {
    expect(tab("- │a")).toBeNull();
    expect(tab("- │a", -1)).toBeNull();
    expect(tab("para│")).toBeNull();
  });

  it("the Tab key lets focus move on from a paragraph, nests an item, holds in a list", () => {
    // A view as the key binding sees it (no completion popup, no IME).
    const press = (src: string, dir: 1 | -1 = 1) => {
      const view = {
        state: st(src),
        composing: false,
        dispatch(t: Transaction) {
          view.state = t.state;
        },
      };
      const handled = tabKey(dir)(view as unknown as EditorView);
      return { handled, doc: show(view.state.update({})) };
    };
    // WCAG 2.1.2: nothing to do on a paragraph, so the key goes on.
    expect(press("para│")).toEqual({ handled: false, doc: "para│" });
    expect(press("para│", -1)).toEqual({ handled: false, doc: "para│" });
    expect(press("# Title│")).toEqual({ handled: false, doc: "# Title│" });
    expect(press("- a\n- │b")).toEqual({ handled: true, doc: "- a\n  - │b" });
    // A first item cannot nest: the key stays in the list (Notion).
    expect(press("- │a")).toEqual({ handled: true, doc: "- │a" });
  });

  it("indents inside a code block; a selection indents its lines", () => {
    expect(tab("```\n│x\n```")).toBe("```\n  │x\n```");
    const s = EditorState.create({
      doc: "```\nline one\nline two\n```",
      selection: { anchor: 4, head: 21 },
      extensions: [mycoMarkdown()],
    });
    expect(tabTr(s, 1)!.state.doc.toString()).toBe(
      "```\n  line one\n  line two\n```",
    );
  });
});

describe("inputRuleTr — Notion input rules", () => {
  it("turns `[] ` into a to-do", () => {
    expect(typed("[]│", " ")).toBe("- [ ] │");
    expect(typed("- []│", " ")).toBe("- [ ] │");
  });

  it("sets `---` under text apart so it is always a divider", () => {
    expect(typed("para\n--│", "-")).toBe("para\n\n---│");
    expect(typed("para\n\n--│", "-")).toBeNull();
    expect(typed("a --│", "-")).toBeNull();
    expect(typed("--│", "-")).toBeNull();
  });

  it("a marker typed at a block's text start changes the block's type", () => {
    // The owner's report: "### " at an H2's start became "## ### title".
    expect(typed("## ###│Title", " ")).toBe("### │Title");
    expect(typed("## ###│", " ")).toBe("### │");
    expect(typed("### #│T", " ")).toBe("# │T");
    expect(typed("- ##│x", " ")).toBe("## │x");
    expect(typed("- 1.│x", " ")).toBe("1. │x");
    expect(typed("1. -│x", " ")).toBe("- │x");
    expect(typed("  - 1.│x", " ")).toBe("  1. │x");
    expect(typed("> ##│q", " ")).toBe("## │q");
    expect(typed("## []│T", " ")).toBe("- [ ] │T");
    expect(typed("## >│T", " ")).toBe("> │T");
  });

  it("keeps a quote when a list marker is typed in it", () => {
    expect(typed("> -│", " ")).toBe("> - │");
    expect(typed("> 1.│x", " ")).toBe("> 1. │x");
  });

  it("leaves numbered headings and nested items with children as text", () => {
    expect(typed("## 1.│x", " ")).toBeNull();
    expect(typed("- a\n  - ##│b\n    - c", " ")).toBeNull();
  });

  it("leaves plain typing alone: no block to convert, or text after the marker", () => {
    expect(typed("##│", " ")).toBeNull();
    expect(typed("## a##│", " ")).toBeNull();
    expect(typed("## ##│", "x")).toBeNull();
  });

  it("never fires in frontmatter or code", () => {
    expect(typed("---\ntitle: x\n--│", "-")).toBeNull();
    expect(typed("```\npara\n--│", "-")).toBeNull();
    expect(typed("```\n[]│", " ")).toBeNull();
  });
});

describe("turnIntoTr — Cmd+Opt+0..8 turn the caret's block into another", () => {
  const turn = (src: string, prefix: string) =>
    show(turnIntoTr(st(src), prefix));

  it("swaps the block marks and keeps the text and caret", () => {
    expect(turn("## Ti│tle", "### ")).toBe("### Ti│tle");
    expect(turn("para│", "# ")).toBe("# para│");
    expect(turn("- [ ] t│", "")).toBe("t│");
    expect(turn("  - n│", "1. ")).toBe("  1. n│");
  });

  it("does nothing in code or frontmatter", () => {
    expect(turn("```\nx│\n```", "# ")).toBeNull();
  });

  it("converts every line of a paragraph with soft lines", () => {
    expect(turn("l1\nl│2", "- ")).toBe("- l1\n- l│2");
    expect(turn("> q1│\n> q2", "")).toBe("q1│\nq2");
  });

  it("Cmd+Opt+7 makes a toggle, Cmd+Opt+8 a code block (Notion's keys)", () => {
    expect(turn("Ide│a", TURN_INTO[7])).toBe("> [!note]- Ide│a");
    expect(turn("## T│", TURN_INTO[8])).toBe("```\nT│\n```");
    expect(TURN_INTO).toHaveLength(9);
  });

  it("Cmd+Opt+0 on a plain paragraph changes nothing", () => {
    // `2024. ` on a soft line is prose, not a list mark to strip.
    expect(turn("The│ year was\n2024. It rained", "")).toBeNull();
  });
});

describe("prefixEnd", () => {
  const at = (src: string) => {
    const s = EditorState.create({ doc: src, extensions: [mycoMarkdown()] });
    return prefixEnd(s, s.doc.line(1));
  };

  it("spans the block marks a line starts with", () => {
    expect(at("## T")).toBe(3);
    expect(at("- [ ] t")).toBe(6);
    expect(at("> - x")).toBe(4);
    expect(at("  - n")).toBe(4);
    expect(at("1. a")).toBe(3);
    expect(at("para")).toBe(0);
  });

  it("ignores marks that are not yet a block (no trigger space)", () => {
    expect(at("#")).toBe(0);
    expect(at("##")).toBe(0);
    expect(at("-")).toBe(0);
  });

  it("reads an unspaced quote mark as a mark", () => {
    expect(at(">_< ok")).toBe(1);
  });
});

describe("hiddenRuns — the spans Live hides at a line start", () => {
  const runs = (src: string) => {
    const s = EditorState.create({ doc: src, extensions: [mycoMarkdown()] });
    return hiddenRuns(s, s.doc.line(1)).map((r) => [r.from, r.to]);
  };

  it("covers hidden marks plus the indent before them", () => {
    expect(runs("## T")).toEqual([[0, 3]]);
    expect(runs("  - n")).toEqual([[0, 4]]);
    expect(runs("- [ ] t")).toEqual([[0, 6]]);
    expect(runs(">   - b")).toEqual([[0, 6]]);
  });

  it("leaves visible marks out (ordered numbers, an unspaced quote)", () => {
    expect(runs("1. a")).toEqual([]);
    expect(runs("> 1. a")).toEqual([[0, 2]]);
    expect(runs(">_< ok")).toEqual([]);
    expect(runs(">> q")).toEqual([[1, 3]]);
  });
});

describe("caretSnap — the caret and selections stay out of hidden marks", () => {
  const snap = (
    src: string,
    anchor: number,
    head = anchor,
    userEvent?: string,
  ) => {
    const s = EditorState.create({
      doc: src,
      extensions: [mycoMarkdown(), liveEditing()],
    });
    const r = s.update({
      selection: EditorSelection.single(anchor, head),
      userEvent,
    }).state.selection.main;
    return [r.anchor, r.head];
  };

  it("snaps a caret inside the marks to the text", () => {
    expect(snap("## T", 0)).toEqual([3, 3]);
    expect(snap(">> q", 1)).toEqual([3, 3]);
    expect(snap(">> q", 0)).toEqual([0, 0]);
  });

  it("drops the marks from a pointer selection and a triple-click", () => {
    expect(snap("a\n\n## Title", 3, 6, "select.pointer")).toEqual([6, 6]);
    expect(snap("a\n\n## Title words", 3, 12, "select.pointer")).toEqual([
      6, 12,
    ]);
    expect(snap("## T\n\nb", 0, 5, "select.pointer")).toEqual([3, 4]);
  });

  it("stops a keyboard selection's head at the text start", () => {
    expect(snap("x\n- bcd", 7, 2, "select")).toEqual([7, 4]);
  });
});

describe("slash menu", () => {
  it("a block item called mid-line is one undo step", () => {
    let state = EditorState.create({
      doc: "hello /table world",
      selection: { anchor: 12 },
      extensions: [mycoMarkdown(), history()],
    });
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    const table = slashItems(STRINGS.en).find((i) => i.label === "table")!;
    applySlash(view, table, 6, 12);
    expect(state.doc.toString()).toBe("hello world\n\n" + TABLE.template);
    undo(view);
    expect(state.doc.toString()).toBe("hello /table world");
  });

  const apply = (src: string, label: string) => {
    let state = st(src);
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const from = line.from + line.text.lastIndexOf("/");
    const item = slashItems(STRINGS.en).find((i) => i.label === label)!;
    applySlash(view, item, from, head);
    const h = state.selection.main.head;
    return state.doc.sliceString(0, h) + CARET + state.doc.sliceString(h);
  };

  it("/toc on its own line becomes the fence, the caret on the line below", () => {
    expect(apply("# T\n\n/toc│", "toc")).toBe("# T\n\n```toc\n```\n│");
  });

  it("/chart under text opens apart: the sample table, its tag, the fence", () => {
    const out = apply("Notes\n/chart│", "chart");
    expect(out.startsWith("Notes\n\n|  | A | B |\n")).toBe(true);
    expect(
      out.endsWith(
        "^chart-data\n\n```chart\ntype: bar\nid: chart-data\ntitle: Sample chart\n```\n│",
      ),
    ).toBe(true);
  });

  it("/chart opens the chart's panel, under its sample table", () => {
    // On a line of its own, and called mid-line (the line kept above it).
    for (const src of ["Notes\n/chart│", "Notes /chart│ end"]) {
      let state = st(src);
      const opened: number[] = [];
      const view = {
        get state() {
          return state;
        },
        dispatch: (t: Transaction) => {
          for (const e of t.effects)
            if (e.is(openBlockEditor)) opened.push(e.value);
          state = t.state;
        },
      };
      const item = slashItems(STRINGS.en).find((i) => i.label === "chart")!;
      const head = state.selection.main.head;
      applySlash(
        view,
        item,
        state.doc.sliceString(0, head).lastIndexOf("/"),
        head,
      );
      const doc = state.doc.toString();
      expect(opened, src).toEqual([doc.indexOf("```chart")]);
    }
  });

  it("/math, /mermaid and /query open their panel, as /chart does", () => {
    for (const label of ["math", "mermaid", "query"]) {
      let state = st("# T\n\n/x│");
      const opened: number[] = [];
      const view = {
        get state() {
          return state;
        },
        dispatch: (t: Transaction) => {
          for (const e of t.effects)
            if (e.is(openBlockEditor)) opened.push(e.value);
          state = t.state;
        },
      };
      const item = slashItems(STRINGS.en).find((i) => i.label === label)!;
      applySlash(view, item, 5, 7);
      // Where the inserted block starts.
      expect(opened, label).toEqual([5]);
    }
  });

  it("a second /chart in a note tags its own table: each chart draws its own", () => {
    let state = st("Notes\n/chart│");
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    const chart = slashItems(STRINGS.en).find((i) => i.label === "chart")!;
    const call = () => {
      const head = state.selection.main.head;
      const from = state.doc.sliceString(0, head).lastIndexOf("/");
      applySlash(view, chart, from, head);
    };
    call();
    view.dispatch(
      state.update({
        changes: { from: state.doc.length, insert: "/chart" },
        selection: { anchor: state.doc.length + 6 },
      }),
    );
    call();
    const doc = state.doc.toString();
    expect(doc.match(/^\^chart-data(?:-\d+)?$/gm)).toEqual([
      "^chart-data",
      "^chart-data-2",
    ]);
    expect(doc.match(/^id: .*$/gm)).toEqual([
      "id: chart-data",
      "id: chart-data-2",
    ]);
    // The second table's first cell changed: only the second chart shows it.
    const last = doc.lastIndexOf("| Q1 | 12 |");
    const html = markdownRenderer.render(
      doc.slice(0, last) + "| Q1 | 99 |" + doc.slice(last + 11),
    );
    const charts = html.split('<div class="md-chart"').slice(1);
    expect(charts).toHaveLength(2);
    expect(charts[0]).toContain('title="Q1 · A: 12"');
    expect(charts[1]).toContain('title="Q1 · A: 99"');
  });

  it("/mermaid under text opens apart: a sample flowchart, caret below", () => {
    expect(apply("Notes\n/mermaid│", "mermaid")).toBe(
      "Notes\n\n```mermaid\nflowchart LR\n  A[Idea] --> B{Worth keeping?}\n  B -->|Yes| C[Write a note]\n  B -->|No| D[Let it go]\n```\n│",
    );
  });

  it("/math on its own line becomes a $$ block, the caret below it", () => {
    expect(apply("# T\n\n/math│", "math")).toBe(
      "# T\n\n$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$\n│",
    );
  });

  it("link to note opens `[[` where typed, even mid-line", () => {
    expect(apply("see /link│ later", "link")).toBe("see [[│ later");
  });

  it("a picker item drops its /query and opens the picker there", () => {
    let state = st("Idea /recall│");
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    const opened: unknown[] = [];
    const item = slashItems(STRINGS.en).find((i) => i.label === "recall")!;
    applySlash(view, item, 5, 12, (mode, pos) => opened.push(mode, pos));
    // Only the query goes: a picker closed without a choice leaves the text
    // exactly as it was before `/recall` was typed.
    expect(state.doc.toString()).toBe("Idea ");
    expect(opened).toEqual(["recall", 5]);
  });

  it("a plugin command drops its /query, then runs on the text as it was", () => {
    let state = st("one two /wordcount│ three");
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    const seen: [string, number][] = [];
    const item = {
      label: "wordcount",
      detail: "Word count",
      aliases: [],
      icon: "◇",
      section: "plugins" as const,
      template: "",
      run: (v: { state: EditorState }) =>
        seen.push([v.state.doc.toString(), v.state.selection.main.head]),
    };
    applySlash(view, item, 8, 18);
    // Only the query goes, as for a picker; the command sees that doc.
    expect(state.doc.toString()).toBe("one two  three");
    expect(seen).toEqual([["one two  three", 8]]);
  });

  it("a picker item in an empty block keeps the block's marks", () => {
    for (const kept of ["- ", "- [ ] ", "## ", "> ", "1. "]) {
      let state = st(kept + "/recall│");
      const view = {
        get state() {
          return state;
        },
        dispatch: (t: Transaction) => {
          state = t.state;
        },
      };
      const opened: number[] = [];
      const item = slashItems(STRINGS.en).find((i) => i.label === "recall")!;
      applySlash(view, item, kept.length, kept.length + 7, (_m, pos) =>
        opened.push(pos),
      );
      expect(state.doc.toString(), kept).toBe(kept);
      expect(opened, kept).toEqual([kept.length]);
    }
  });

  it("a block item typed in an empty block never breaks its marks", () => {
    expect(apply("- /table│", "table")).toBe(`- \n\n${TABLE.template}│`);
  });

  it("/table: 3 × 3 empty cells, set apart, and its first cell takes the caret", () => {
    let state = st("intro\n/table│\nend");
    const opened: number[] = [];
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        for (const e of t.effects) if (e.is(openBlockEditor)) opened.push(e.value);
        state = t.state;
      },
    };
    const item = slashItems(STRINGS.en).find((i) => i.label === "table")!;
    applySlash(view, item, 6, 12);
    expect(TABLE.template).toBe(
      "|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |",
    );
    expect(state.doc.toString()).toBe(`intro\n\n${TABLE.template}\n\nend`);
    // The widget opens its first header cell where the table starts.
    expect(opened).toEqual([7]);
  });

  it("/embed opens `![[` on its own block, set apart from text around it", () => {
    expect(apply("/embed│", "embed")).toBe("![[│");
    expect(apply("para\n/embed│\nnext", "embed")).toBe("para\n\n![[│\n\nnext");
    expect(apply("see /embed│ more", "embed")).toBe("see more\n\n![[│");
  });

  it("/image opens the file picker there; the image lands as its own block", () => {
    // What Editor's pickImage does with the chosen file: insertBlockTr at the
    // picker's position, as /recall inserts.
    const image = (src: string) => {
      let state = st(src);
      const view = {
        get state() {
          return state;
        },
        dispatch: (t: Transaction) => {
          state = t.state;
        },
      };
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      const from = line.from + line.text.lastIndexOf("/");
      const opened: unknown[] = [];
      const item = slashItems(STRINGS.en).find((i) => i.label === "image")!;
      applySlash(view, item, from, head, (mode, pos) => opened.push(mode, pos));
      const cancelled = state.doc.toString();
      const tr = insertBlockTr(state, opened[1] as number, "![](assets/x.png)");
      return { opened, cancelled, doc: show(tr) };
    };
    expect(image("Shot: /image│")).toEqual({
      opened: ["image", 6],
      cancelled: "Shot: ",
      doc: "Shot: \n\n![](assets/x.png)│",
    });
    // Under a paragraph, the image is no lazy line of it: set apart.
    expect(image("para\n/image│").doc).toBe("para\n\n![](assets/x.png)│");
    expect(image("see /image│ more").doc).toBe(
      "see  more\n\n![](assets/x.png)│",
    );
  });

  it("callout and toggle turn the line into their quote text", () => {
    expect(apply("Tip /callout│", "callout")).toBe("> [!note] Tip│");
    expect(apply("/toggle│", "toggle")).toBe("> [!note]- │");
  });
});

describe("keys on a note the parser has not finished", () => {
  // A new state's first parse gets 20 ms of wall clock (CM's Work.Apply); a
  // busy machine spends that before the parser reaches the caret's line.
  // Here every Date.now() call is a second later, so it stops after a block.
  const starved = (make: () => EditorState): EditorState => {
    let t = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
    try {
      return make();
    } finally {
      clock.mockRestore();
    }
  };
  const unfinished = (s: EditorState) => {
    expect(syntaxTree(s).length).toBeLessThan(s.doc.length);
    return s;
  };
  const head = "a\n\nb\n\nc\n\n";

  it("Backspace still drops the caret line's innermost mark", () => {
    const s = unfinished(starved(() => st(head + "> - a\n> - │b\n> - c")));
    expect(show(backspaceTr(s))).toBe(head + "> - a\n>\n> │b\n>\n> - c");
  });

  it("Enter still continues the list and splits a bold span", () => {
    const item = unfinished(starved(() => st(head + "- item│")));
    expect(show(enterTr(item))).toBe(head + "- item\n- │");
    const bold = unfinished(starved(() => st(head + "some **bold │text** x")));
    expect(show(enterTr(bold))).toBe(head + "some **bold**\n\n**│text** x");
  });

  it("Tab still nests the selected items", () => {
    const s = unfinished(starved(() => sel(head + "- a\n- ‹b\n- c›")));
    expect(show(tabTr(s, 1))).toBe(head + "- a\n  - b\n  - c│");
  });

  it("a blank line inside a fence is still no gap", () => {
    const s = unfinished(starved(() => st(head + "```\n\nx\n```│")));
    expect(isGapLine(s, 8)).toBe(false);
  });
});

describe("bodyStart", () => {
  it("lands after the frontmatter and a lone seed title", () => {
    const stub = "---\ntype: concept\n---\n\n# Title\n";
    expect(bodyStart(stub)).toBe(stub.length);
    expect(bodyStart("# 2026-09-25\n\n")).toBe("# 2026-09-25\n\n".length);
  });

  it("counts in CodeMirror's normalized text for CRLF files", () => {
    // The raw offset overshot the doc CM stores and crashed the app on open.
    const crlf = "---\r\ntype: x\r\n---\r\n\r\n# Title\r\n";
    const state = EditorState.create({ doc: crlf });
    expect(bodyStart(crlf)).toBe(state.doc.length);
    expect(bodyStart("---\r\na: 1\r\n---\r\n\r\n## Head\r\nbody")).toBe(17);
  });

  it("lands on the first content when there is a body", () => {
    expect(bodyStart("---\na: 1\n---\n\nHello")).toBe(14);
    expect(bodyStart("## Intro\n\ntext")).toBe(3);
    expect(bodyStart("")).toBe(0);
  });
});
