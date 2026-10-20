import { describe, expect, it } from "vitest";
import { cpuMs } from "./cpuMs";
import {
  frontmatterLength,
  markdownRenderer,
  stripFrontmatter,
} from "./markdown";

describe("stripFrontmatter", () => {
  it("removes a leading YAML frontmatter block", () => {
    const md = "---\ntitle: Hello\ntags:\n  - a\n---\n# Body\n\ntext";
    expect(stripFrontmatter(md)).toBe("# Body\n\ntext");
  });

  it("handles CRLF line endings", () => {
    expect(stripFrontmatter("---\r\ntitle: x\r\n---\r\n# Body")).toBe("# Body");
  });

  it("leaves a document without frontmatter untouched", () => {
    const md = "# No frontmatter\n\njust body";
    expect(stripFrontmatter(md)).toBe(md);
  });

  it("does not treat a mid-document --- as frontmatter", () => {
    const md = "intro\n---\nnot frontmatter";
    expect(stripFrontmatter(md)).toBe(md);
  });

  it("leaves an unterminated frontmatter fence untouched", () => {
    const md = "---\nonly: open\n# never closes";
    expect(stripFrontmatter(md)).toBe(md);
  });
});

describe("frontmatterLength", () => {
  it("equals what stripFrontmatter removes", () => {
    const fixtures = [
      "---\ntitle: Hello\ntags:\n  - a\n---\n# Body\n\ntext",
      "---\r\ntitle: x\r\n---\r\n# Body",
      "# No frontmatter\n\njust body",
      "intro\n---\nnot frontmatter",
      "---\nonly: open\n# never closes",
    ];
    for (const md of fixtures) {
      expect(frontmatterLength(md)).toBe(
        md.length - stripFrontmatter(md).length,
      );
    }
    expect(frontmatterLength(fixtures[0])).toBe(33);
    expect(frontmatterLength(fixtures[2])).toBe(0);
  });
});

describe("headings", () => {
  it("stamps the 0-based source line on each heading", () => {
    const html = markdownRenderer.render(
      "# One\n\ntext\n\n## Two\n\nSet\n===",
    );
    expect(html).toContain('<h1 data-line="0">One</h1>');
    expect(html).toContain('<h2 data-line="4">Two</h2>');
  });

  it("reads no setext headings, like the editor", () => {
    // `=` typed under a paragraph once turned it into an H1 here but not in
    // the editor; the outline listed a paragraph as a heading.
    const html = markdownRenderer.render("Set\n===\n\npara\n---");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<h2");
    expect(html).toContain("<hr>");
  });
});

describe("images", () => {
  const env = { vaultRoot: "/v", toUrl: (p: string) => "u:" + p };

  it("routes vault-relative sources through toUrl when an env is given", () => {
    expect(markdownRenderer.render("![x](assets/a.png)", env)).toContain(
      '<img src="u:/v/assets/a.png" alt="x">',
    );
  });

  it("resolves ./ against the note directory", () => {
    const html = markdownRenderer.render("![](./a.png)", {
      ...env,
      noteDir: "/v/wiki",
    });
    expect(html).toContain('src="u:/v/wiki/a.png"');
  });

  it("leaves remote sources and env-less renders untouched", () => {
    expect(markdownRenderer.render("![x](https://h/a.png)", env)).toContain(
      'src="https://h/a.png"',
    );
    expect(markdownRenderer.render("![x](assets/a.png)")).toContain(
      'src="assets/a.png"',
    );
  });

  it("renders an Obsidian image embed from assets/", () => {
    expect(markdownRenderer.render("![[shot.png]]", env)).toContain(
      '<img src="u:/v/assets/shot.png" alt="shot.png">',
    );
    expect(markdownRenderer.render("![[shot.png|cap]]")).toContain(
      '<img src="assets/shot.png" alt="cap">',
    );
    expect(markdownRenderer.render("![[assets/shot.png]]")).toContain(
      'src="assets/shot.png"',
    );
  });

  it("keeps a non-image embed inside text as a wikilink", () => {
    expect(markdownRenderer.render("see ![[note]] here")).toContain(
      '!<a data-link="note" class="myco-wikilink" href="#">note</a>',
    );
  });

  it("renders a note's own link as written, like the Live editor draws it", () => {
    // Page Preview, embeds and Live block widgets must read the same as Live's
    // plain lines, which show the link text itself.
    const id = "claude-code-064ddbe4-251d-4da1-8315-da096a5b75ff";
    expect(markdownRenderer.render(`- [[${id}]]`)).toContain(
      `<a data-link="${id}" class="myco-wikilink" href="#">${id}</a>`,
    );
  });

  it("shows an opaque session link by its display name where the caller asks (Ask, Spotlight)", () => {
    const id = "claude-code-064ddbe4-251d-4da1-8315-da096a5b75ff";
    expect(markdownRenderer.render(`- [[${id}]]`, { displayNames: true })).toContain(
      `<a data-link="${id}" class="myco-wikilink" href="#" title="${id}">Claude Code · 064ddbe4</a>`,
    );
    // An alias is the author's own choice of text; it stays.
    expect(markdownRenderer.render(`[[${id}|the server run]]`, { displayNames: true })).toContain(
      `<a data-link="${id}" class="myco-wikilink" href="#">the server run</a>`,
    );
  });

  it("turns a non-image embed alone in its paragraph into a note embed", () => {
    expect(markdownRenderer.render("![[note]]")).toContain(
      '<div class="md-embed" data-embed="note">',
    );
  });
});

describe("footnotes", () => {
  it("renders a reference as a superscript linked to a list at the end", () => {
    const html = markdownRenderer.render(
      "Claim[^src-a].\n\n[^src-a]: From [[source-a]], p. 2",
    );
    expect(html).toContain(
      '<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>',
    );
    expect(html).toContain('<section class="footnotes">');
    expect(html).toContain('<li id="fn1" class="footnote-item">');
    // The definition keeps its inline markdown: the wikilink stays a link.
    expect(html).toContain(
      '<a data-link="source-a" class="myco-wikilink" href="#">source-a</a>',
    );
    expect(html).toContain('href="#fnref1" class="footnote-backref"');
  });

  it("renders adjacent references both", () => {
    const html = markdownRenderer.render("x[^a][^b]\n\n[^a]: A\n[^b]: B");
    expect(html.match(/class="footnote-ref"/g)).toHaveLength(2);
    expect(html).toContain('href="#fn2"');
  });

  it("numbers a repeated reference like its first one", () => {
    const html = markdownRenderer.render("x[^a] y[^a]\n\n[^a]: A");
    expect(html.match(/>\[1\]<\/a><\/sup>/g)).toHaveLength(2);
    expect(html).not.toContain("[1:1]");
    expect(html).toContain('id="fnref1:1"');
  });

  it("renders a daily note whose quote definition sits between capture lines", () => {
    // Default 8: capture_note writes the definition after the quote's line,
    // and later captures append below it as list items again.
    const html = markdownRenderer.render(
      "# d\n- 09:00 Q [^src-clip]\n\n[^src-clip]: raw/clip.md\n- 09:05 milk\n",
    );
    expect(html.match(/class="footnote-ref"/g)).toHaveLength(1);
    expect(html).toContain('<li id="fn1" class="footnote-item"><p>raw/clip.md');
    expect(html).toMatch(/<li>09:05 milk<\/li>/);
  });

  it("leaves a reference with no definition as text", () => {
    const html = markdownRenderer.render("x[^nope]");
    expect(html).toContain("[^nope]");
    expect(html).not.toContain("footnote");
  });

  it("never echoes a label into the HTML", () => {
    const html = markdownRenderer.render('x[^<b>"]\n\n[^<b>"]: y');
    expect(html).toContain('class="footnote-ref"');
    expect(html).not.toContain("<b>");
  });
});

describe("task lists", () => {
  it("renders [ ] / [x] items as disabled checkboxes, marker text gone", () => {
    const html = markdownRenderer.render("- [ ] open\n- [x] done\n- [X] Done");
    expect(html.match(/<input type="checkbox" disabled>/g)).toHaveLength(1);
    expect(
      html.match(/<input type="checkbox" disabled checked>/g),
    ).toHaveLength(2);
    expect(html).toContain(
      '<li class="task-list-item"><input type="checkbox" disabled> open</li>',
    );
    expect(html).not.toContain("[x]");
  });

  it("reads loose, ordered, quoted and empty to-dos like the editor", () => {
    const boxes = (md: string): number =>
      (markdownRenderer.render(md).match(/type="checkbox"/g) ?? []).length;
    expect(boxes("- [ ] a\n\n- [x] b")).toBe(2);
    expect(boxes("1. [x] one")).toBe(1);
    expect(boxes("> - [ ] q")).toBe(1);
    // Lezer needs the space after `]`: `- [ ] ` is a to-do, `- [x]` is not.
    expect(boxes("- [ ] ")).toBe(1);
    expect(boxes("- [x]")).toBe(0);
    expect(boxes("- [ ]x")).toBe(0);
    expect(boxes("[ ] not a list")).toBe(0);
  });

  it("the reader's Preview (env.tasks) gets live boxes naming their source line", () => {
    const html = markdownRenderer.render("# T\n\n- [ ] open\n- [x] done\n\n> 1. [ ] q", {
      tasks: true,
    });
    expect(html).toContain('<input type="checkbox" data-task-line="2" aria-label="open">');
    expect(html).toContain('<input type="checkbox" data-task-line="3" aria-label="done" checked>');
    expect(html).toContain('data-task-line="5"');
    expect(html).not.toContain("disabled");
  });

  it("each live box is named by its task's text, so a screen reader tells them apart", () => {
    const names = (md: string): string[] =>
      [...markdownRenderer.render(md, { tasks: true }).matchAll(/aria-label="([^"]*)"/g)].map(
        (m) => m[1],
      );
    expect(names("- [ ] provenance **panel** #dev\n- [x] see [[a-note|the note]]\n- [ ] ")).toEqual([
      "provenance panel #dev",
      "see the note",
      "Toggle task",
    ]);
    expect(names("- [ ] one\n  two\n  - [ ] nested")).toEqual(["one two", "nested"]);
    expect(names("- [ ] hard  \n  break")).toEqual(["hard break"]);
    expect(names('- [ ] <b>"x"</b>')).toEqual(["&lt;b&gt;&quot;x&quot;&lt;/b&gt;"]);
    expect(names("- [ ] solve $x^2$ now")).toEqual(["solve $x^2$ now"]);
  });

  it("a box is no block: with source lines, the item holds the line (a citation lights the row)", () => {
    const html = markdownRenderer.render("- [ ] open\n- [x] done", {
      tasks: true,
      sourceLines: true,
    });
    expect(html).toContain('<li class="task-list-item" data-line="0">');
    expect(html).not.toMatch(/<input[^>]*\sdata-line=/);
  });
});

describe("HTML comments", () => {
  it("renders an inline comment as nothing", () => {
    const html = markdownRenderer.render("a <!-- note --> b");
    expect(html).toBe("<p>a  b</p>\n");
  });

  it("renders a block comment as nothing", () => {
    expect(markdownRenderer.render("<!-- one\ntwo -->\n\ntext")).toBe(
      "<p>text</p>\n",
    );
    // Unclosed: CommonMark runs it to the end of the document, as Lezer does.
    expect(markdownRenderer.render("<!-- open\nmore")).toBe("");
  });

  it("keeps text after the closing mark on the comment's last line", () => {
    expect(markdownRenderer.render("<!-- c --> <tail> <!-- d -->")).toBe(
      "<p>&lt;tail&gt;</p>\n",
    );
  });

  it("leaves comments in code and unclosed inline ones as text", () => {
    expect(markdownRenderer.render("`<!-- x -->`")).toContain(
      "<code>&lt;!-- x --&gt;</code>",
    );
    expect(markdownRenderer.render("```\n<!-- x -->\n```")).toContain(
      "&lt;!-- x --&gt;",
    );
    expect(markdownRenderer.render("a <!-- b")).toContain("a &lt;!-- b");
  });
});

// Both were O(n²) on the UI thread (Preview of any note, clipped sources
// included): at 16 000 repeats each took seconds; linear, well under 50 ms.
describe("rendering stays linear in the note's size", () => {
  const timed = (md: string): [string, number] => [
    markdownRenderer.render(md),
    cpuMs(() => markdownRenderer.render(md)),
  ];

  it("with many unclosed `<!--`", () => {
    const [html, ms] = timed("text <!-- ".repeat(16000));
    expect(html.startsWith("<p>text &lt;!-- text")).toBe(true);
    expect(ms).toBeLessThan(500);
  });

  it("with many bare `- [ ] ` to-dos", () => {
    const [html, ms] = timed(Array(16000).fill("- [ ] ").join("\n"));
    expect(html.match(/type="checkbox"/g)).toHaveLength(16000);
    expect(ms).toBeLessThan(500);
  });
});

describe("source lines (the reader's Preview)", () => {
  it("marks every block with its first body line when asked", () => {
    const html = markdownRenderer.render("# H\n\nOne\ntwo\n\n- a\n- b\n\n```\ncode\n```\n", {
      sourceLines: true,
    });
    expect(html).toContain('<p data-line="2">One\ntwo</p>');
    expect(html).toContain('<ul data-line="5">\n<li data-line="5">a</li>\n<li data-line="6">b</li>');
    expect(html).toContain('<code data-line="8">code');
  });

  it("leaves the HTML unmarked otherwise", () => {
    expect(markdownRenderer.render("One\n\n- a\n")).toBe("<p>One</p>\n<ul>\n<li>a</li>\n</ul>\n");
  });
});
