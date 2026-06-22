import { describe, expect, it } from "vitest";
import { stripFrontmatter } from "./markdown";

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
