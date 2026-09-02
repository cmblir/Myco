import { describe, expect, it } from "vitest";
import { frontmatterLength, stripFrontmatter } from "./markdown";

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
