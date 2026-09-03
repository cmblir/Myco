import { describe, expect, it } from "vitest";
import { bodyLineOffset, extractHeadings } from "./outline";

describe("extractHeadings", () => {
  it("returns ATX headings with level, text and 0-based body line", () => {
    expect(extractHeadings("# A\n\ntext\n\n## B\n### C")).toEqual([
      { level: 1, text: "A", line: 0 },
      { level: 2, text: "B", line: 4 },
      { level: 3, text: "C", line: 5 },
    ]);
  });

  it("reads setext headings", () => {
    expect(extractHeadings("Title\n=====\n\nSub\n---")).toEqual([
      { level: 1, text: "Title", line: 0 },
      { level: 2, text: "Sub", line: 3 },
    ]);
  });

  it("skips a # line inside a code fence", () => {
    expect(extractHeadings("```\n# not a heading\n```\n# yes")).toEqual([
      { level: 1, text: "yes", line: 3 },
    ]);
  });

  it("strips inline markup down to the visible text", () => {
    expect(extractHeadings("# **b** `c` [[L|Alias]]")).toEqual([
      { level: 1, text: "b c Alias", line: 0 },
    ]);
  });

  it("returns [] for an empty body", () => {
    expect(extractHeadings("")).toEqual([]);
  });
});

describe("bodyLineOffset", () => {
  it("is 0 without frontmatter", () => {
    expect(bodyLineOffset("# Body")).toBe(0);
  });

  it("counts the lines the frontmatter block occupies", () => {
    expect(bodyLineOffset("---\na: 1\n---\n")).toBe(3);
    expect(bodyLineOffset("---\na\nb\n---\n# Body")).toBe(4);
  });

  it("handles CRLF line endings", () => {
    expect(bodyLineOffset("---\r\na: 1\r\n---\r\n# Body")).toBe(3);
  });
});
