// The graph toolbar's markup under react-dom/server (node env, no DOM).

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GraphQuestions, { honestyDetails, honestyNote } from "./GraphQuestions";
import type { SurveyCounts } from "./GraphQuestions";
import { DEFAULT_GRAPH_SETTINGS } from "../lib/graphSettings";
import { STRINGS } from "../lib/i18n";

const COUNTS: SurveyCounts = {
  total: 12,
  sample: 2,
  own: 10,
  unresolved: 1,
  gaps: 7,
  orphans: 3,
  noBacklink: 2,
  clusters: 4,
  maplessClusters: 1,
  fresh30d: 5,
  neighbors: null,
  sessions: 40,
  cited: 6,
};

const bar = (): string =>
  renderToStaticMarkup(
    h(GraphQuestions, {
      t: STRINGS.ko,
      settings: DEFAULT_GRAPH_SETTINGS,
      counts: COUNTS,
      build: { builds: 3, ms: 242.2 },
      onChange: (): undefined => undefined,
    }),
  );

afterEach(() => vi.unstubAllEnvs());

// UX S14: "씬 재빌드 3회 · 242.2 ms" was on every user's graph. It is a
// developer's check that typing in the find field does not rebuild the scene.
describe("the rebuild chip", () => {
  it("shows on the dev server", () => {
    vi.stubEnv("DEV", true);
    expect(bar()).toContain("graph-rebuilds");
  });

  it("is absent from a production build", () => {
    vi.stubEnv("DEV", false);
    const html = bar();
    expect(html).not.toContain("graph-rebuilds");
    expect(html).not.toContain("242.2");
  });
});

// UX S14: the frame's note was a paragraph of counts (drawn nodes, first-run
// sample %, unresolved, cited, excluded sessions). One plain line stays; the
// rest moves under the legend's 자세히.
describe("the graph's stats line", () => {
  it("says how many of your notes there are and how many links are missing", () => {
    expect(honestyNote(STRINGS.ko, COUNTS)).toBe("내 노트 10개, 연결이 빠진 곳 7개");
    for (const lang of ["en", "ja"] as const) {
      const line = honestyNote(STRINGS[lang], COUNTS);
      expect(line).toContain("10");
      expect(line).toContain("7");
    }
  });

  it("keeps every other count for the legend's details", () => {
    const t = STRINGS.ko;
    const lines = honestyDetails(t, COUNTS, 30);
    const all = lines.join("\n");
    for (const n of ["12", "30", "2", "17%", "1", "6", "40"]) expect(all).toContain(n);
    expect(all).not.toContain(honestyNote(t, COUNTS));
  });
});
