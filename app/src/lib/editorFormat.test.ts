import { describe, expect, it } from "vitest";
import {
  EditorSelection,
  EditorState,
  type Transaction,
} from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { mycoMarkdown } from "./editorBlocks";
import { markdownRenderer } from "./markdown";
import {
  BOLD,
  CODE,
  HIGHLIGHT,
  ITALIC,
  LINK,
  formatKeymap,
  formatTr,
  linkApply,
  type Format,
} from "./editorFormat";

// `│` is the caret; `‹…›` a selection (anchor ‹, head ›).
function st(src: string, extra: unknown[] = []): EditorState {
  const caret = src.indexOf("│");
  const plain = src.replace("│", "").replace("‹", "");
  const a = caret >= 0 ? caret : src.indexOf("‹");
  const h = caret >= 0 ? caret : plain.indexOf("›");
  return EditorState.create({
    doc: plain.replace("›", ""),
    selection: EditorSelection.single(a, h),
    extensions: [mycoMarkdown(), ...(extra as [])],
  });
}

function show(t: Transaction | null): string | null {
  if (!t) return null;
  const { doc, selection } = t.state;
  const { from, to } = selection.main;
  const d = doc.toString();
  return from === to
    ? d.slice(0, from) + "│" + d.slice(from)
    : d.slice(0, from) + "‹" + d.slice(from, to) + "›" + d.slice(to);
}

const fmt = (src: string, f: Format) => show(formatTr(st(src), f));

describe("formatTr — wrapping a selection", () => {
  it("wraps the selection, the text stays selected", () => {
    expect(fmt("make ‹bold› now", BOLD)).toBe("make **‹bold›** now");
    expect(fmt("‹word›", ITALIC)).toBe("*‹word›*");
    expect(fmt("‹word›", HIGHLIGHT)).toBe("==‹word›==");
    expect(fmt("run ‹ls -la›", CODE)).toBe("run `‹ls -la›`");
  });

  it("keeps the blanks a selection took outside the marks", () => {
    expect(fmt("a‹ word ›b", BOLD)).toBe("a **‹word›** b");
  });

  it("wraps each line's text past its block marks", () => {
    expect(fmt("# ‹Title\n- item›", BOLD)).toBe("# **‹Title**\n- **item›**");
    expect(fmt("‹one\n\ntwo›", ITALIC)).toBe("*‹one*\n\n*two›*");
  });

  it("takes a span into the wrap it overlaps, no stray marks left", () => {
    expect(fmt("‹a **b** c›", BOLD)).toBe("**‹a b c›**");
    expect(fmt("‹a **b› c**", BOLD)).toBe("**‹a b› c**");
  });

  it("keeps punctuation before a Korean particle outside the marks", () => {
    // CommonMark's flanking rule: `**` between `)` and `는` is no mark.
    const drawn = (src: string, f: Format, tag: string, node: string) => {
      const t = formatTr(st(src), f);
      const html = t ? markdownRenderer.render(t.state.doc.toString()) : "";
      let live = 0;
      if (t)
        syntaxTree(t.state).iterate({
          enter: (n) => void (n.name === node && live++),
        });
      return { shown: show(t), html: html.includes(`<${tag}>`), live };
    };
    expect(
      drawn("‹API(인터페이스)›는 좋다", BOLD, "strong", "StrongEmphasis"),
    ).toEqual({ shown: "**‹API(인터페이스**)›는 좋다", html: true, live: 1 });
    expect(drawn('‹"인용"›은 좋다', BOLD, "strong", "StrongEmphasis")).toEqual({
      shown: '**‹"인용**"›은 좋다',
      html: true,
      live: 1,
    });
    expect(drawn('는‹"인용"›', BOLD, "strong", "StrongEmphasis")).toEqual({
      shown: '는‹"**인용"›**',
      html: true,
      live: 1,
    });
    expect(
      drawn("‹API(인터페이스)›는", HIGHLIGHT, "mark", "Highlight"),
    ).toEqual({ shown: "==‹API(인터페이스==)›는", html: true, live: 1 });
    expect(drawn("‹메모.›를", ITALIC, "em", "Emphasis")).toEqual({
      shown: "*‹메모*.›를",
      html: true,
      live: 1,
    });
    // A mark run the new one joins is no punctuation of the text's.
    expect(drawn("‹*a*›는", BOLD, "strong", "StrongEmphasis")).toEqual({
      shown: "**‹*a*›**는",
      html: true,
      live: 1,
    });
  });

  it("holds the key where no mark before a particle could render", () => {
    expect(fmt("‹)›는", BOLD)).toBeNull();
    expect(fmt("‹[[note]]›는", BOLD)).toBeNull();
    expect(fmt("‹`x`›는", ITALIC)).toBeNull();
  });

  it("is one undo step", () => {
    let state = st("say ‹hi›", [history()]);
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    view.dispatch(state.update({ changes: { from: 0, insert: "x" } }));
    view.dispatch(formatTr(state, BOLD)!);
    expect(state.doc.toString()).toBe("xsay **hi**");
    undo(view);
    expect(state.doc.toString()).toBe("xsay hi");
  });
});

describe("formatTr — a mark on a mark takes it off (Notion)", () => {
  it("unwraps a span selected with or without its marks", () => {
    expect(fmt("a **‹bold›** b", BOLD)).toBe("a ‹bold› b");
    expect(fmt("a ‹**bold**› b", BOLD)).toBe("a ‹bold› b");
    expect(fmt("*‹it›*", ITALIC)).toBe("‹it›");
    expect(fmt("`‹code›`", CODE)).toBe("‹code›");
    expect(fmt("==‹hi›==", HIGHLIGHT)).toBe("‹hi›");
  });

  it("takes a part of a span out of it", () => {
    expect(fmt("**hello ‹world›**", BOLD)).toBe("**hello** ‹world›");
    expect(fmt("**‹hello› world**", BOLD)).toBe("‹hello› **world**");
    expect(fmt("**a ‹b› c**", BOLD)).toBe("**a** ‹b› **c**");
  });

  it("tells a bold span from an italic one", () => {
    expect(fmt("**‹word›**", ITALIC)).toBe("***‹word›***");
    expect(fmt("***‹word›***", ITALIC)).toBe("**‹word›**");
    expect(fmt("***‹word›***", BOLD)).toBe("*‹word›*");
  });

  it("unwraps every line only when every line is marked", () => {
    expect(fmt("**‹a**\n**b›**", BOLD)).toBe("‹a\nb›");
    expect(fmt("**‹a**\nb›", BOLD)).toBe("**‹a**\n**b›**");
  });

  it("takes a span across a soft line off once, no mark at a line break", () => {
    expect(fmt("**‹a\nb›**", BOLD)).toBe("‹a\nb›");
    expect(fmt("x **‹one\ntwo›**", BOLD)).toBe("x ‹one\ntwo›");
    expect(fmt("**a\n‹b›**", BOLD)).toBe("**a**\n‹b›");
    expect(fmt("**‹a›\nb**", BOLD)).toBe("‹a›\n**b**");
    expect(fmt("**a\n‹b›\nc**", BOLD)).toBe("**a**\n‹b›\n**c**");
    expect(fmt("> **a\n> ‹b›**", BOLD)).toBe("> **a**\n> ‹b›");
    expect(fmt("> **‹a›\n> b**", BOLD)).toBe("> ‹a›\n> **b**");
  });

  it("splits the outer span outside a mark the word sits in", () => {
    expect(fmt("**a *‹b›* c**", BOLD)).toBe("**a** *‹b›* **c**");
    expect(fmt("**a ==‹b›== c**", BOLD)).toBe("**a** ==‹b›== **c**");
    expect(fmt("**a ~~‹b›~~ c**", BOLD)).toBe("**a** ~~‹b›~~ **c**");
    expect(fmt("*a **‹b›** c*", ITALIC)).toBe("*a* **‹b›** *c*");
    expect(fmt("==a *‹b›* c==", HIGHLIGHT)).toBe("==a== *‹b›* ==c==");
    // Pressed again, the word takes the mark back: no marks pile up.
    expect(fmt("**a** *‹b›* **c**", BOLD)).toBe("**a** ***‹b›*** **c**");
  });
});

describe("formatTr — at the caret", () => {
  it("opens an empty pair to type into; pressed again it goes", () => {
    expect(fmt("say │", BOLD)).toBe("say **│**");
    expect(fmt("say **│**", BOLD)).toBe("say │");
    expect(fmt("│", ITALIC)).toBe("*│*");
    expect(fmt("*│*", ITALIC)).toBe("│");
    expect(fmt("│", HIGHLIGHT)).toBe("==│==");
  });

  it("an italic pair inside an empty bold pair is its own", () => {
    expect(fmt("**│**", ITALIC)).toBe("***│***");
  });

  it("steps out of the span the caret ends or starts", () => {
    expect(fmt("**bold│** x", BOLD)).toBe("**bold**│ x");
    expect(fmt("x **│bold**", BOLD)).toBe("x │**bold**");
  });

  it("splits a span the caret is in the middle of", () => {
    expect(fmt("**wo│rd**", BOLD)).toBe("**wo**│**rd**");
  });

  it("code and link need a selection (the keys go on)", () => {
    expect(fmt("text│", CODE)).toBeNull();
    expect(fmt("text│", LINK)).toBeNull();
  });
});

describe("formatTr — ⌘K links the selection", () => {
  it("wraps it as a wikilink with the caret before `]]`", () => {
    expect(fmt("see ‹attention› here", LINK)).toBe("see [[attention│]] here");
  });

  it("a link selected, or a part of it, becomes its text again", () => {
    expect(fmt("see ‹[[attention]]›", LINK)).toBe("see ‹attention›");
    expect(fmt("see [[‹attention›]]", LINK)).toBe("see ‹attention›");
    expect(fmt("see [[a-note|‹shown›]]", LINK)).toBe("see ‹shown›");
  });

  it("leaves a selection across a link or lines alone", () => {
    expect(fmt("‹a [[b]] c›", LINK)).toBeNull();
    expect(fmt("‹a\nb›", LINK)).toBeNull();
  });
});

describe("formatTr — block syntax keeps its meaning", () => {
  it("wraps a table's cells, never its pipes or its delimiter row", () => {
    expect(fmt("‹intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nend›", BOLD)).toBe(
      "**‹intro**\n\n| **a** | **b** |\n| - | - |\n| **1** | **2** |\n\n**end›**",
    );
    expect(fmt("‹| a | b |\n| - | - |\n| 1 | 2 |›", CODE)).toBe(
      "| `‹a` | `b` |\n| - | - |\n| `1` | `2›` |",
    );
    expect(fmt("| a | b |\n‹| - | - |›\n| 1 | 2 |", BOLD)).toBeNull();
  });

  it("leaves a divider and a link reference alone", () => {
    expect(fmt("‹para\n\n---\n\nnext›", BOLD)).toBe(
      "**‹para**\n\n---\n\n**next›**",
    );
    expect(fmt("‹[x]: http://a.b›", ITALIC)).toBeNull();
  });

  it("wraps a footnote's body past its `[^id]:` label", () => {
    expect(fmt("‹text[^1]\n\n[^1]: the source›", BOLD)).toBe(
      "**‹text[^1]**\n\n[^1]: **the source›**",
    );
  });

  it("wraps a callout's title past its `[!type]`", () => {
    expect(fmt("‹> [!note] Title\n> body›", BOLD)).toBe(
      "> [!note] **‹Title**\n> **body›**",
    );
    expect(fmt("‹> [!tip]- T›", ITALIC)).toBe("> [!tip]- *‹T›*");
    expect(fmt("‹> [!note]›", BOLD)).toBeNull();
  });

  it("leaves a line drawn as a block (an embed, an image) alone", () => {
    expect(fmt("‹![[note#H]]›", BOLD)).toBeNull();
    expect(fmt("‹a\n\n> ![[note]]\n\nb›", BOLD)).toBe(
      "**‹a**\n\n> ![[note]]\n\n**b›**",
    );
    expect(fmt("‹![[shot.png]]›", HIGHLIGHT)).toBeNull();
  });
});

describe("formatTr — code text, URLs and link targets never take a mark", () => {
  it("marks a code span or a link whole when the selection ends inside it", () => {
    expect(fmt("x `a ‹b› c` y", BOLD)).toBe("x **`a ‹b› c`** y");
    expect(fmt("see [[‹no›te]] x", BOLD)).toBe("see **[[‹no›te]]** x");
    expect(fmt("see [[note|al‹ia›s]]", ITALIC)).toBe("see *[[note|al‹ia›s]]*");
    expect(fmt("‹a [[no›te]] b", HIGHLIGHT)).toBe("==‹a [[no›te]]== b");
    expect(fmt("see ![[‹a›]] x", BOLD)).toBe("see **![[‹a›]]** x");
    expect(fmt("see ‹[[note]]›", BOLD)).toBe("see **‹[[note]]›**");
  });

  it("takes a mark off around a code span or link, never inside it", () => {
    expect(fmt("**see `‹code›` here**", BOLD)).toBe(
      "**see** `‹code›` **here**",
    );
    expect(fmt("**see [[‹note›]] here**", BOLD)).toBe(
      "**see** [[‹note›]] **here**",
    );
  });

  it("holds the key where no mark can go", () => {
    expect(fmt("`ab│c`", BOLD)).toBeNull();
    expect(fmt("[[no│te]]", ITALIC)).toBeNull();
    expect(fmt("[t](http://‹x›.y)", ITALIC)).toBeNull();
    expect(fmt("[t](http://x.y│)", BOLD)).toBeNull();
    expect(fmt("see http://‹x›.y", BOLD)).toBeNull();
    expect(fmt("see [[‹no›te]] x", CODE)).toBeNull();
    expect(fmt("x `a ‹b› c` y", LINK)).toBeNull();
    expect(fmt("`‹code›`", CODE)).toBe("‹code›");
  });

  it("⌘K leaves an embed alone", () => {
    expect(fmt("see ![[a|‹b›]]", LINK)).toBeNull();
    expect(fmt("see ![[‹a›]]", LINK)).toBeNull();
    expect(fmt("see ‹![[a]]›", LINK)).toBeNull();
    expect(fmt("see ‹[[a]]›", LINK)).toBe("see ‹a›");
  });
});

describe("formatTr — never in code or frontmatter", () => {
  it("returns null inside a fence, raw HTML and frontmatter", () => {
    expect(fmt("```\n‹code›\n```", BOLD)).toBeNull();
    expect(fmt("```\nx│\n```", BOLD)).toBeNull();
    expect(fmt("---\ntitle: ‹x›\n---\n\nbody", ITALIC)).toBeNull();
    expect(fmt("‹para\n```\ncode›\n```", BOLD)).toBeNull();
  });

  it("returns null for several selections", () => {
    const s = EditorState.create({
      doc: "a b",
      selection: EditorSelection.create([
        EditorSelection.range(0, 1),
        EditorSelection.range(2, 3),
      ]),
      extensions: [
        mycoMarkdown(),
        EditorState.allowMultipleSelections.of(true),
      ],
    });
    expect(formatTr(s, BOLD)).toBeNull();
  });
});

describe("linkApply — a picked note in `[[…]]`", () => {
  const pick = (src: string, text: string) => {
    let state = st(src);
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: Parameters<EditorState["update"]>[0]) => {
        state = state.update(spec).state;
      },
    };
    const head = state.selection.main.head;
    const from = state.doc.sliceString(0, head).lastIndexOf("[[") + 2;
    linkApply(text)(view as never, { label: text }, from, head);
    return show(state.update({}));
  };

  it("replaces the `]]` ⌘K left after the caret instead of doubling it", () => {
    expect(pick("see [[att│]] here", "attention]]")).toBe(
      "see [[attention]]│ here",
    );
  });

  it("closes a link typed without one", () => {
    expect(pick("see [[att│", "attention]]")).toBe("see [[attention]]│");
  });
});

describe("⌘K, then a picked note — the selected words stay the text", () => {
  // The editor's flow: ⌘K wraps the words, the `[[` list picks a target.
  const flow = (src: string) => {
    let state = st(src, [formatKeymap(), history()]);
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction | Parameters<EditorState["update"]>[0]) => {
        state = "startState" in t ? t.state : state.update(t).state;
      },
    };
    const run = (f: (v: typeof view) => unknown) => (
      f(view),
      show(state.update({}))
    );
    const pick = (text: string) =>
      run((v) => {
        const head = v.state.selection.main.head;
        const from = v.state.doc.sliceString(0, head).lastIndexOf("[[") + 2;
        linkApply(text)(v as never, { label: text }, from, head);
      });
    return { view, run, pick, doc: () => state.doc.toString() };
  };

  it("links the words to the note, the words its shown text", () => {
    const f = flow("오늘 ‹the paper›을 읽었다");
    expect(f.run((v) => v.dispatch(formatTr(v.state, LINK)!))).toBe(
      "오늘 [[the paper│]]을 읽었다",
    );
    expect(f.pick("transformer-architecture#Transformer Architecture]]")).toBe(
      "오늘 [[transformer-architecture#Transformer Architecture|the paper]]│을 읽었다",
    );
    undo(f.view);
    expect(f.doc()).toBe("오늘 [[the paper]]을 읽었다");
    undo(f.view);
    expect(f.doc()).toBe("오늘 the paper을 읽었다");
  });

  it("takes no alias for a note named as the words", () => {
    const f = flow("read ‹attention› now");
    f.run((v) => v.dispatch(formatTr(v.state, LINK)!));
    expect(f.pick("attention]]")).toBe("read [[attention]]│ now");
    const g = flow("read ‹attention› now");
    g.run((v) => v.dispatch(formatTr(v.state, LINK)!));
    expect(g.pick("Attention]]")).toBe("read [[attention]]│ now");
  });

  it("keeps the words while the query is typed, not once the caret left", () => {
    const f = flow("a ‹the paper› b");
    f.run((v) => v.dispatch(formatTr(v.state, LINK)!));
    f.run((v) =>
      v.dispatch(v.state.update(v.state.replaceSelection(" trans"))),
    );
    expect(f.pick("transformer]]")).toBe("a [[transformer|the paper]]│ b");
    const g = flow("a ‹the paper› b");
    g.run((v) => v.dispatch(formatTr(v.state, LINK)!));
    const inside = g.view.state.selection.main.head;
    g.run((v) => v.dispatch(v.state.update({ selection: { anchor: 0 } })));
    g.run((v) => v.dispatch(v.state.update({ selection: { anchor: inside } })));
    expect(g.pick("transformer]]")).toBe("a [[transformer]]│ b");
  });
});
