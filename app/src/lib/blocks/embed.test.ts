import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { EMBED, embedTarget } from "./embed";
import { liveBlocks } from "./live";
import { mycoMarkdown } from "../editorBlocks";
import { markdownRenderer } from "../markdown";

// The editor's own parser: GFM with setext headings off.
const { parser } = mycoMarkdown().language;
const lezer = (src: string) =>
  liveBlocks(parser.parse(src), Text.of(src.split("\n")));
const ids = (src: string) => lezer(src).map((b) => b.spec.id);

describe("embed block: parse", () => {
  it("reads the note, the heading and a header label", () => {
    expect(EMBED.parse("![[note#My Heading]]")).toEqual({
      target: "note#My Heading",
      note: "note",
      heading: "My Heading",
      label: "note › My Heading",
    });
    expect(EMBED.parse("![[note]]")).toEqual({
      target: "note",
      note: "note",
      heading: null,
      label: "note",
    });
    expect(EMBED.parse("![[note#H|Shown]]")?.label).toBe("Shown");
  });

  it("is no embed for an image, this note's own heading, a PDF pin or text around it", () => {
    expect(EMBED.parse("![[x.png]]")).toBeNull();
    expect(EMBED.parse("![[#Heading]]")).toBeNull();
    expect(EMBED.parse("![[pdf::paper#p3]]")).toBeNull();
    expect(EMBED.parse("![[note]] tail")).toBeNull();
    expect(EMBED.parse("[[note]]")).toBeNull();
  });

  it("splits a target the Viewer reads back from its placeholder", () => {
    expect(embedTarget("n#H")).toEqual({ note: "n", heading: "H" });
    expect(embedTarget("n")).toEqual({ note: "n", heading: null });
    expect(embedTarget("n#")).toEqual({ note: "n", heading: null });
    expect(embedTarget("#H")).toBeNull();
  });
});

describe("embed block: Live", () => {
  it("draws `![[note#H]]` alone on its line, an image embed stays an image", () => {
    expect(ids("![[note#H]]")).toEqual(["embed"]);
    expect(ids("![[note]]\n\n![[x.png]]")).toEqual(["embed", "image"]);
  });

  it("leaves an embed inside text or on a list item's marker line as text", () => {
    expect(ids("see ![[note]] here")).toEqual([]);
    expect(ids("- ![[note]]")).toEqual([]);
  });

  it("draws an embed in a quote, a callout body or a list item's own line", () => {
    expect(ids("> ![[note]]")).toEqual(["embed"]);
    expect(ids("> [!tip] T\n> ![[note#H]]")).toEqual(["embed"]);
    expect(ids("- a\n\n  ![[note]]")).toEqual(["embed"]);
  });
});

describe("embed block: Preview", () => {
  it("renders a placeholder the Viewer fills: header link, empty body, no <p>", () => {
    const html = markdownRenderer.render("![[note#H]]");
    expect(html).toBe(
      '<div class="md-embed" data-embed="note#H"><div class="md-embed-head"><a data-link="note#H" class="myco-wikilink" href="#">note › H</a></div><div class="md-embed-body"></div></div>\n',
    );
  });

  it("keeps an embed inside text as `!` and a wikilink", () => {
    expect(markdownRenderer.render("see ![[note]] here")).toContain(
      'see !<a data-link="note" class="myco-wikilink" href="#">note</a> here',
    );
  });

  it("embeds in a list item's own line and a callout body too", () => {
    expect(markdownRenderer.render("- a\n\n  ![[note]]")).toContain(
      '<div class="md-embed" data-embed="note">',
    );
    // On the marker line it stays `!` + a link, as Live keeps it.
    expect(markdownRenderer.render("- ![[note]]")).toContain(
      '<li>!<a data-link="note"',
    );
    const callout = markdownRenderer.render("> [!tip]\n> ![[note]]");
    expect(callout).toContain('data-callout="tip"');
    expect(callout).toContain('<div class="md-embed" data-embed="note">');
  });

  it("escapes the target and the label", () => {
    const html = markdownRenderer.render(
      '![[<img src=x onerror=alert(1)>#"q"|<b>x</b>]]',
    );
    expect(html).not.toMatch(/<img|<b>/);
    expect(html).toContain('data-embed="&lt;img src=x onerror=alert(1)&gt;#&quot;q&quot;"');
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;</a>");
  });
});
