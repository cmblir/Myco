import { describe, expect, it } from "vitest";
import { buildMorningHeadline, topSuspects } from "./overviewReport";
import { STRINGS } from "./i18n";

describe("buildMorningHeadline", () => {
  it("names runs and moved pages in Korean", () => {
    const s = buildMorningHeadline({ runsSince: 2, pagesMoved: 7, lang: "ko" }, STRINGS.ko);
    expect(s).toContain("2");
    expect(s).toContain("7");
  });
  it("falls back to a quiet line when nothing happened", () => {
    const s = buildMorningHeadline({ runsSince: 0, pagesMoved: 0, lang: "en" }, STRINGS.en);
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toContain("0 runs");
  });
});

describe("topSuspects", () => {
  it("returns the n pages with the most reasons first", () => {
    const r = {
      pages_checked: 3,
      suspects: [
        { page: "a.md", reasons: ["x"] },
        { page: "b.md", reasons: ["x", "y", "z"] },
        { page: "c.md", reasons: ["x", "y"] },
      ],
    };
    expect(topSuspects(r, 2).map((s) => s.page)).toEqual(["b.md", "c.md"]);
  });
});
