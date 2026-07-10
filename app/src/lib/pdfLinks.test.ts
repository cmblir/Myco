import { describe, expect, it } from "vitest";
import { parsePdfTarget, formatPdfLink } from "./wikilinks";
import {
  parseSidecar,
  serializeSidecar,
  emptySidecar,
  makeAnchorId,
  type Sidecar,
} from "./annotations";

describe("parsePdfTarget", () => {
  it("parses stem + page + anchor id", () => {
    expect(parsePdfTarget("pdf::attention#p3:a1b2")).toEqual({
      stem: "attention",
      page: 3,
      anchorId: "a1b2",
    });
  });
  it("parses a page-only link (no anchor)", () => {
    expect(parsePdfTarget("pdf::scaling-laws#p1")).toEqual({
      stem: "scaling-laws",
      page: 1,
      anchorId: "",
    });
  });
  it("rejects non-pdf and malformed targets", () => {
    expect(parsePdfTarget("attention-mechanism")).toBeNull();
    expect(parsePdfTarget("pdf::x")).toBeNull();
    expect(parsePdfTarget("pdf::x#pZ")).toBeNull();
    expect(parsePdfTarget("pdf::x#p0")).toBeNull();
  });
});

describe("formatPdfLink round-trips with parsePdfTarget", () => {
  it("with an anchor", () => {
    const link = { stem: "attention", page: 3, anchorId: "a1b2" };
    const md = formatPdfLink(link, "scaled attention");
    expect(md).toBe("[[pdf::attention#p3:a1b2|scaled attention]]");
    // strip [[ ]] and |label to re-parse the target
    const target = md.slice(2, md.indexOf("|"));
    expect(parsePdfTarget(target)).toEqual(link);
  });
  it("without a label or anchor", () => {
    const md = formatPdfLink({ stem: "s", page: 2, anchorId: "" });
    expect(md).toBe("[[pdf::s#p2]]");
    expect(parsePdfTarget(md.slice(2, -2))).toEqual({ stem: "s", page: 2, anchorId: "" });
  });
});

describe("sidecar serialize/parse", () => {
  it("round-trips anchors", () => {
    const sc: Sidecar = {
      source: "raw/attention.pdf",
      anchors: [
        {
          id: "p3-0-abcd",
          page: 3,
          quads: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
          text: "scaled dot-product attention",
          color: "#ffd54f",
          note: "wiki/attention-mechanism.md",
          created: "2026-07-10T00:00:00Z",
        },
      ],
    };
    const back = parseSidecar("raw/attention.pdf", serializeSidecar(sc));
    expect(back).toEqual(sc);
  });
  it("treats corrupt JSON as an empty sidecar", () => {
    expect(parseSidecar("raw/a.pdf", "{not json")).toEqual(emptySidecar("raw/a.pdf"));
    expect(parseSidecar("raw/a.pdf", '{"anchors": "nope"}').anchors).toEqual([]);
  });
});

describe("makeAnchorId", () => {
  it("is deterministic and page/seq-scoped", () => {
    const a = makeAnchorId(3, "hello", 0);
    const b = makeAnchorId(3, "hello", 0);
    expect(a).toBe(b);
    expect(a.startsWith("p3-0-")).toBe(true);
    expect(makeAnchorId(3, "hello", 1)).not.toBe(a);
  });
});
