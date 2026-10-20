import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type Token from "markdown-it/lib/token.mjs";
import { CALLOUT_TYPES, parseCalloutHead } from "./callout";
import { STRINGS } from "../i18n";
import {
  calloutBlocks,
  composeEnded,
  foldTr,
  liveCallouts,
} from "./calloutLive";
import { mycoMarkdown } from "../editorBlocks";
import { markdownRenderer } from "../markdown";

// The editor's own parser: GFM with setext headings off.
const { parser } = mycoMarkdown().language;

const lezer = (src: string) =>
  liveCallouts(parser.parse(src), Text.of(src.split("\n")));

/** Every callout markdown-it finds, as Live reports it. */
function preview(src: string) {
  const out: { type: string; fold: string; title: string }[] = [];
  const walk = (tokens: Token[]) => {
    for (const t of tokens) {
      if (t.type === "callout_open") {
        const { type, fold, title } = t.meta;
        out.push({ type, fold, title });
      }
      if (t.children) walk(t.children);
    }
  };
  walk(markdownRenderer.parse(src, {}));
  return out;
}

describe("parseCalloutHead", () => {
  it("reads the kind, the fold sign and the title", () => {
    expect(parseCalloutHead("[!tip] Try this")).toEqual({
      type: "tip",
      fold: "",
      title: "Try this",
      tagLen: 7,
    });
    expect(parseCalloutHead("[!note]- Folded")).toMatchObject({
      fold: "-",
      tagLen: 9,
    });
    expect(parseCalloutHead("[!info]+")).toMatchObject({
      fold: "+",
      title: "",
      tagLen: 8,
    });
  });

  it("takes GitHub's five alerts, any case", () => {
    for (const t of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"])
      expect(parseCalloutHead(`[!${t}]`)?.type).toBe(t.toLowerCase());
    expect(parseCalloutHead("[!Warning] x")?.type).toBe("warning");
  });

  it("leaves unknown kinds and other brackets a quote", () => {
    expect(parseCalloutHead("[!nope] x")).toBeNull();
    expect(parseCalloutHead("[note] x")).toBeNull();
    expect(parseCalloutHead("text [!note]")).toBeNull();
  });
});

describe("callout parity: Live (Lezer) and Preview (markdown-it) agree", () => {
  const samples = [
    "> [!note] Title\n> body",
    "> [!NOTE]\n> GitHub body",
    "> [!tip]- Fold me\n> hidden",
    "> [!warning]+ Open\n> x",
    "> [!success]Title",
    "> [!quote] Q\n>\n> para two",
    "> [!question] Why?\n> \\# literal\n> \\> literal",
    "> [!caution]\n> - item",
    "> [!danger] T\nlazy line",
    "> > [!info] nested",
    "> [!note] outer\n> > [!tip] inner",
    "- > [!danger] in a list",
    "text\n> [!important] after a paragraph",
    "> [!unknown] x",
    "> text\n> [!note] not first",
    ">\n> [!note] first line empty",
    "```\n> [!note] in code\n```",
    "    > [!note] indented code",
    "---\ntitle: x\n---\n> [!tip] after frontmatter",
  ];
  it.each(samples)("%j", (src) => {
    const live = lezer(src).map(({ type, fold, title }) => ({
      type,
      fold,
      title,
    }));
    const body = src.startsWith("---")
      ? src.slice(src.indexOf("\n>") + 1)
      : src;
    expect(preview(body)).toEqual(live);
  });

  it("finds what the samples mean", () => {
    expect(lezer("> [!unknown] x")).toEqual([]);
    expect(lezer("> > [!info] nested")).toHaveLength(1);
    expect(lezer("> [!note] outer\n> > [!tip] inner")).toHaveLength(2);
  });
});

describe("liveCallouts", () => {
  it("covers the quote's lines; the tag is `[!type]-` and its space", () => {
    expect(lezer("> [!tip]- Hi\n> body\n\nnext")).toEqual([
      {
        from: 0,
        to: 19,
        titleTo: 12,
        tag: { from: 2, to: 10 },
        type: "tip",
        fold: "-",
        title: "Hi",
      },
    ]);
  });

  it("starts a nested callout at its line, outer before inner", () => {
    const src = "> [!note] outer\n> > [!tip] inner";
    expect(lezer(src).map((c) => [c.type, c.from, c.tag.from])).toEqual([
      ["note", 0, 2],
      ["tip", 16, 20],
    ]);
  });

  it("ignores the frontmatter", () => {
    expect(lezer("---\na: > [!note]\n---\n> [!note] x")).toMatchObject([
      { from: 21 },
    ]);
  });
});

describe("Preview renders callouts", () => {
  const html = (src: string) => markdownRenderer.render(src);

  it("a box with the title's inline markdown and the body under it", () => {
    expect(html("> [!tip] Hi **there**\n> body")).toBe(
      '<div class="callout" data-callout="tip">' +
        '<div class="callout-title">Hi <strong>there</strong></div>\n' +
        "<p>body</p>\n</div>\n",
    );
  });

  it("titles an untitled callout by its kind, as GitHub and Obsidian do", () => {
    expect(html("> [!NOTE]\n> body")).toContain(
      '<div class="callout-title">Note</div>',
    );
    // No body: the box holds the title only.
    expect(html("> [!warning] Careful")).toBe(
      '<div class="callout" data-callout="warning">' +
        '<div class="callout-title">Careful</div>\n</div>\n',
    );
  });

  it("names an untitled callout's kind in the UI's language", () => {
    const ko = markdownRenderer.render("> [!warning]\n> 본문", {
      strings: STRINGS.ko,
    });
    expect(ko).toContain('<div class="callout-title">경고</div>');
    expect(
      markdownRenderer.render("> [!tip]- \n> x", { strings: STRINGS.ja }),
    ).toContain('<summary class="callout-title">ヒント</summary>');
    // A written title is the file's own text: never translated.
    expect(
      markdownRenderer.render("> [!tip] Tip", { strings: STRINGS.ko }),
    ).toContain(">Tip</div>");
  });

  it("has a kind name for every kind, in every language", () => {
    for (const lang of ["en", "ko", "ja"] as const)
      for (const type of CALLOUT_TYPES)
        expect(
          STRINGS[lang][`callout_kind_${type}`],
          `${lang} ${type}`,
        ).toMatch(/\S/);
  });

  it("a toggle is a <details>: closed with `-`, open with `+`", () => {
    const closed = html("> [!note]- More\n> hidden");
    expect(closed).toContain(
      '<details class="callout" data-callout="note"><summary class="callout-title">More</summary>',
    );
    expect(closed).toContain("<p>hidden</p>\n</details>");
    expect(html("> [!note]+ More\n> shown")).toContain(
      'data-callout="note" open><summary',
    );
  });

  it("keeps the body's blocks and a nested callout", () => {
    const out = html("> [!note] Outer\n> - item\n>\n> > [!tip] Inner\n> > x");
    expect(out).toContain("<ul>\n<li>item</li>\n</ul>");
    expect(out).toContain('<div class="callout" data-callout="tip">');
    expect(out).not.toContain("<blockquote>");
  });

  it("escapes the title and body", () => {
    const out = html("> [!note] <script>alert(1)</script>\n> <img src=x>");
    expect(out).not.toMatch(/<script|<img/);
    expect(out).toContain("&lt;script&gt;");
  });

  it("leaves an unknown kind or a later tag a quote", () => {
    expect(html("> [!nope] x")).toContain("<blockquote>");
    expect(html("> text\n> [!note] x")).toContain("<blockquote>");
  });
});

describe("calloutBlocks field", () => {
  const make = (doc: string, anchor = doc.length) =>
    EditorState.create({
      doc,
      selection: { anchor },
      extensions: [mycoMarkdown(), calloutBlocks()],
    });
  /** The wrappers the field provides: [from, to, class, data-callout]. */
  const wrappers = (s: EditorState) =>
    s.facet(EditorView.blockWrappers).flatMap((set) => {
      if (typeof set === "function") return [];
      const out: [number, number, string, string][] = [];
      set.between(0, s.doc.length, (from, to, w) => {
        out.push([from, to, w.attributes.class, w.attributes["data-callout"]]);
      });
      return out;
    });
  /** The decorations: [from, to, kind] — fold (a hidden body), hide (the
   *  tag), or the title line's attribute. */
  const decos = (s: EditorState) =>
    s.facet(EditorView.decorations).flatMap((d) => {
      if (typeof d === "function") return [];
      const out: [number, number, string][] = [];
      d.between(0, s.doc.length, (from, to, v) => {
        const kind = v.spec.block
          ? "fold"
          : v.spec.class
            ? `title${v.spec.attributes?.["data-title"] ? ":" + v.spec.attributes["data-title"] : ""}`
            : "hide";
        out.push([from, to, kind]);
      });
      return out;
    });

  const CALLOUT = "> [!tip] Hi\n> body\n\nend";

  it("wraps the callout's lines in a box of its kind", () => {
    expect(wrappers(make(CALLOUT))).toEqual([[0, 18, "live-callout", "tip"]]);
  });

  it("hides `[!type] ` unless a caret is on the title line", () => {
    expect(decos(make(CALLOUT))).toEqual([
      [0, 0, "title"],
      [2, 9, "hide"],
    ]);
    expect(decos(make(CALLOUT, 5))).toEqual([[0, 0, "title"]]);
    // The body line is not the title line: the tag stays hidden.
    expect(decos(make(CALLOUT, 15))).toContainEqual([2, 9, "hide"]);
  });

  it("an untitled callout's kind reads in the UI's language", () => {
    const s = EditorState.create({
      doc: "> [!warning]\n> 본문\n\nend",
      selection: { anchor: 20 },
      extensions: [mycoMarkdown(), calloutBlocks(STRINGS.ko)],
    });
    expect(decos(s)[0]).toEqual([0, 0, "title:경고"]);
  });

  it("an untitled callout shows its kind's name while the tag is hidden", () => {
    expect(decos(make("> [!NOTE]\n> x\n\nend"))[0]).toEqual([
      0,
      0,
      "title:Note",
    ]);
    expect(decos(make("> [!NOTE]\n> x\n\nend", 3))[0]).toEqual([0, 0, "title"]);
  });

  const TOGGLE = "> [!note]- T\n> b1\n> b2\n\nend";

  it("`-` folds the body away by default; `+` shows it", () => {
    const closed = make(TOGGLE);
    expect(decos(closed)).toContainEqual([13, 22, "fold"]);
    expect(wrappers(closed)[0][2]).toBe("live-callout is-closed");
    const open = make(TOGGLE.replace("]-", "]+"));
    expect(decos(open).some((d) => d[2] === "fold")).toBe(false);
    expect(wrappers(open)[0][2]).toBe("live-callout is-open");
  });

  it("shows a folded body while a caret is in it", () => {
    const s = make(TOGGLE, 15);
    expect(decos(s).some((d) => d[2] === "fold")).toBe(false);
    expect(wrappers(s)[0][2]).toBe("live-callout is-open");
    // The title line's end is not in the body.
    expect(decos(make(TOGGLE, 12))).toContainEqual([13, 22, "fold"]);
  });

  it("foldTr opens and closes without touching the file", () => {
    const s = make(TOGGLE);
    const opened = foldTr(s, 0)!;
    expect(opened.docChanged).toBe(false);
    expect(decos(opened.state).some((d) => d[2] === "fold")).toBe(false);
    expect(wrappers(opened.state)[0][2]).toBe("live-callout is-open");
    const closed = foldTr(opened.state, 0)!;
    expect(closed.docChanged).toBe(false);
    expect(decos(closed.state)).toContainEqual([13, 22, "fold"]);
    // Not a toggle, or no callout there: nothing to do.
    expect(foldTr(make(CALLOUT), 0)).toBeNull();
    expect(foldTr(s, 3)).toBeNull();
  });

  it("foldTr with no position folds the toggle around the caret, the caret out of the body", () => {
    const s = make(TOGGLE.replace("]-", "]+"), 16);
    const t = foldTr(s)!;
    expect(t.state.selection.main.head).toBe(12);
    expect(decos(t.state)).toContainEqual([13, 22, "fold"]);
    // Visible only because of the caret: closing just moves the caret out.
    const peek = make(TOGGLE, 16);
    const back = foldTr(peek)!;
    expect(back.state.selection.main.head).toBe(12);
    expect(decos(back.state)).toContainEqual([13, 22, "fold"]);
    expect(foldTr(make(CALLOUT, 3))).toBeNull();
  });

  it("the fold state follows the text through edits", () => {
    const opened = foldTr(make(TOGGLE), 0)!.state;
    const moved = opened.update({
      changes: { from: 0, insert: "intro\n\n" },
    }).state;
    expect(decos(moved).some((d) => d[2] === "fold")).toBe(false);
    expect(wrappers(moved)[0].slice(0, 3)).toEqual([
      7,
      29,
      "live-callout is-open",
    ]);
  });

  it("never rebuilds mid-composition: the set is only mapped", () => {
    const s = make(CALLOUT);
    const composed = s.update({
      changes: { from: 0, insert: "한" },
      selection: EditorSelection.cursor(6),
      userEvent: "input.type.compose",
    }).state;
    // The caret is now on the title line, yet the tag stays hidden (shifted).
    expect(decos(composed)).toContainEqual([3, 10, "hide"]);
    // (A rebuild would find no callout: `한>` opens no quote.)
    expect(wrappers(composed)).toEqual([[0, 19, "live-callout", "tip"]]);
    // Nor on an effect-only transaction mid-composition (autocomplete's).
    const idle = composed.update({}).state;
    expect(wrappers(idle)).toEqual([[0, 19, "live-callout", "tip"]]);
    expect(decos(idle)).toContainEqual([3, 10, "hide"]);
    // The composition's end rebuilds.
    const ended = idle.update({ effects: composeEnded.of(null) }).state;
    expect(wrappers(ended)).toEqual([]);
  });

  it("the line typed after a callout joins its box only once composed", () => {
    // `한글` typed on the empty line under the callout is a lazy line of the
    // quote: the box may grow to it only after the composition ends.
    const src = "intro\n\n> [!tip] Title\n> body\n";
    let s = make(src);
    const box = wrappers(s);
    for (const [i, ch] of ["ㅎ", "하", "한"].entries()) {
      s = s.update({
        changes: {
          from: src.length,
          to: i === 0 ? src.length : src.length + 1,
          insert: ch,
        },
        userEvent: "input.type.compose",
      }).state;
      s = s.update({}).state; // autocomplete's effect-only transaction
      expect(wrappers(s)).toEqual(box);
    }
    s = s.update({ effects: composeEnded.of(null) }).state;
    expect(wrappers(s)[0][1]).toBe(src.length + 1);
  });
});
