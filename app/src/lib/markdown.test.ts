import { describe, expect, it } from "vitest";
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

  it("keeps a non-image embed as a wikilink", () => {
    expect(markdownRenderer.render("![[note]]")).toContain(
      '!<a data-link="note" class="myco-wikilink" href="#">note</a>',
    );
  });
});
