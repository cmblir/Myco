import { describe, expect, it } from "vitest";
import { fenceBody, mathSource, stripLead, withBody } from "./fenceSource";

describe("a fenced block's source, as a panel rewrites it", () => {
  it("reads the body between the fence lines, past the container marks", () => {
    expect(fenceBody("```chart\ntype: bar\nid: x\n```", "")).toBe(
      "type: bar\nid: x",
    );
    expect(fenceBody("> ```mermaid\n> a --> b\n>   c\n> ```", "> ")).toBe(
      "a --> b\n  c",
    );
    // An item's indent, and a blank line written as the bare mark.
    expect(fenceBody("  ```x\n    a\n\n  b\n  ```", "  ")).toBe("  a\n\nb");
    expect(fenceBody("> ```x\n>\n> b\n> ```", "> ")).toBe("\nb");
    expect(fenceBody("```x\n```", "")).toBe("");
  });

  it("strips as markdown-it does: one `>` per quote level, then the indent", () => {
    const strip = stripLead("> > ");
    expect(strip("> > a")).toBe("a");
    expect(strip(">> a")).toBe("a");
    expect(strip("> a")).toBe("a");
    expect(stripLead("   ")("     x")).toBe("  x");
  });

  it("writes the body between the fence's own lines, each led by the marks", () => {
    expect(
      withBody("~~~~chart extra\nold\n~~~~", "", "type: line\nid: y"),
    ).toBe("~~~~chart extra\ntype: line\nid: y\n~~~~");
    expect(withBody("> ```chart\n> old\n> ```", "> ", "a\n\nb")).toBe(
      "> ```chart\n> a\n>\n> b\n> ```",
    );
    expect(withBody("  ```q\n  x\n  ```", "  ", "tag:a")).toBe(
      "  ```q\n  tag:a\n  ```",
    );
    expect(withBody("```q\nx\n```", "", "")).toBe("```q\n```");
  });

  it("round-trips: the body read back is the body written", () => {
    for (const [src, lead] of [
      ["```chart\ntype: bar\n```", ""],
      ["> ```mermaid\n> a\n>\n> b\n> ```", "> "],
      ["  ```x\n    deep\n  ```", "  "],
    ] as const) {
      const body = fenceBody(src, lead);
      expect(fenceBody(withBody(src, lead, body), lead)).toBe(body);
    }
  });

  it("writes a formula as a $$ block, blank lines out (they would end it)", () => {
    expect(mathSource("", "a^2\n\n+ b^2")).toBe("$$\na^2\n+ b^2\n$$");
    expect(mathSource("> ", "x")).toBe("> $$\n> x\n> $$");
  });
});
