import { describe, expect, it } from "vitest";
import { bodyLineOffset, extractHeadings, sectionBody } from "./outline";

describe("extractHeadings", () => {
  it("returns ATX headings with level, text and 0-based body line", () => {
    expect(extractHeadings("# A\n\ntext\n\n## B\n### C")).toEqual([
      { level: 1, text: "A", line: 0 },
      { level: 2, text: "B", line: 4 },
      { level: 3, text: "C", line: 5 },
    ]);
  });

  it("ignores setext underlines, like the editor", () => {
    expect(extractHeadings("Title\n=====\n\nSub\n---")).toEqual([]);
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

  it("keeps $…$ math as written, so its links and embeds still resolve", () => {
    expect(extractHeadings("## A $x$")[0].text).toBe("A $x$");
    expect(extractHeadings("## $E=mc^2$")[0].text).toBe("$E=mc^2$");
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

  it("counts a lone CR as a line, as markdown-it and the editor do", () => {
    expect(bodyLineOffset("---\na: 1\rb: 2\n---\n# Body")).toBe(4);
  });
});

describe("sectionBody", () => {
  const body =
    "# A\n\nintro\n\n## My Section\n\nb text\n\n### Sub\n\nsub\n\n```\n## not a heading\n```\n\n## C\n\nc end";

  it("is the heading's lines up to the next heading of its level or above", () => {
    expect(sectionBody(body, "My Section")).toBe(
      "b text\n\n### Sub\n\nsub\n\n```\n## not a heading\n```",
    );
    expect(sectionBody(body, "Sub")).toBe(
      "sub\n\n```\n## not a heading\n```",
    );
  });

  it("runs to the end for the last section", () => {
    expect(sectionBody(body, "C")).toBe("c end");
  });

  it("matches the anchor as [[note#…]] does (case, slug)", () => {
    expect(sectionBody(body, "my-section")).toBe(sectionBody(body, "My Section"));
    expect(sectionBody(body, "c")).toBe("c end");
  });

  it("finds a heading holding math by its text as written", () => {
    const math = "## Area $\\pi r^2$\nbody\n\n## $E=mc^2$\nmore";
    expect(sectionBody(math, "Area $\\pi r^2$")).toBe("body");
    expect(sectionBody(math, "$E=mc^2$")).toBe("more");
  });

  it("is null for a missing heading and for a ^block-id", () => {
    expect(sectionBody(body, "Nope")).toBeNull();
    expect(sectionBody("para ^abc\n", "^abc")).toBeNull();
    expect(sectionBody(body, "")).toBeNull();
  });
});
