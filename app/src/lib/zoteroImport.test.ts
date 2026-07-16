import { describe, expect, it } from "vitest";
import { inboxFilename, parseZoteroExport, toSourceMarkdown } from "./zoteroImport";

const CSL = JSON.stringify([
  {
    title: "Attention Is All You Need",
    author: [{ family: "Vaswani", given: "Ashish" }, { literal: "Google Brain" }],
    issued: { "date-parts": [[2017, 6]] },
    DOI: "10.48550/arXiv.1706.03762",
    annotations: [
      { text: "Scaled dot-product attention", pageLabel: "3", comment: "core idea" },
      { text: "   " }, // blank → skipped
    ],
  },
  { notitle: true }, // unusable → skipped
]);

const BIB = `@article{vaswani2017,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  year = {2017},
  doi = {10.48550/arXiv.1706.03762}
}
@misc{empty}
`;

describe("parseZoteroExport", () => {
  it("parses CSL-JSON with authors, year, and annotations", () => {
    const items = parseZoteroExport(CSL);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Attention Is All You Need");
    expect(items[0].authors).toEqual(["Ashish Vaswani", "Google Brain"]);
    expect(items[0].year).toBe("2017");
    expect(items[0].annotations).toHaveLength(1);
    expect(items[0].annotations[0].page).toBe("3");
  });

  it("parses BibTeX entries and skips ones without titles", () => {
    const items = parseZoteroExport(BIB);
    expect(items).toHaveLength(1);
    expect(items[0].authors).toEqual(["Vaswani Ashish", "Shazeer Noam"]);
    expect(items[0].year).toBe("2017");
  });

  it("returns [] on garbage without throwing", () => {
    expect(parseZoteroExport("not an export")).toEqual([]);
    expect(parseZoteroExport("{broken json")).toEqual([]);
  });
});

describe("markdown rendering", () => {
  it("renders title, meta, and quoted highlights", () => {
    const [item] = parseZoteroExport(CSL);
    const md = toSourceMarkdown(item);
    expect(md).toContain("# Attention Is All You Need");
    expect(md).toContain("Ashish Vaswani");
    expect(md).toContain("> Scaled dot-product attention (p. 3)");
    expect(md).toContain("> — core idea");
  });

  it("builds a safe inbox filename", () => {
    const [item] = parseZoteroExport(CSL);
    expect(inboxFilename(item)).toBe("zotero-attention-is-all-you-need.md");
  });
});
