import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GraphLegend, { legendKey } from "./GraphLegend";
import type { LegendGalaxy } from "../lib/graphData";
import { STRINGS } from "../lib/i18n";

const t = STRINGS.en;

describe("legendKey — the lines that explain the ACTIVE question", () => {
  it("leads with the encoding of the question being asked", () => {
    expect(legendKey(t, { question: "orphans", layout: "galaxy", hasSubject: false })).toEqual([
      t.gr_enc_orphans,
    ]);
    expect(legendKey(t, { question: "clusters", layout: "galaxy", hasSubject: false })).toEqual([
      t.gr_enc_clusters,
    ]);
    expect(legendKey(t, { question: "time", layout: "galaxy", hasSubject: false })).toEqual([
      t.gr_enc_time,
    ]);
  });

  it("asks for a subject before describing hop brightness that is not applied yet", () => {
    expect(legendKey(t, { question: "neighbors", layout: "galaxy", hasSubject: false })).toEqual([
      t.gr_q_pick,
    ]);
    expect(legendKey(t, { question: "neighbors", layout: "galaxy", hasSubject: true })).toEqual([
      t.gr_enc_neighbors,
    ]);
  });

  it("does not ask for a note while open-in-graph is still landing on one (UX S44)", () => {
    expect(
      legendKey(t, { question: "neighbors", layout: "galaxy", hasSubject: false, arriving: true }),
    ).toEqual([t.gr_enc_neighbors]);
  });

  it("adds the time axis under the chronicle layout", () => {
    expect(legendKey(t, { question: "time", layout: "strata", hasSubject: false })).toEqual([
      t.gr_enc_time,
      t.gr_enc_strata,
    ]);
  });

  it("describes the recency ramp graphEncoding actually draws (30 / 90 days)", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      expect(STRINGS[lang].gr_enc_time).toContain("30");
      expect(STRINGS[lang].gr_enc_time).toContain("90");
    }
  });
});

describe("the legend's 자세히", () => {
  const galaxies: LegendGalaxy[] = [
    {
      g: 0,
      label: "wiki",
      color: "#888",
      count: 3,
      clusters: [{ cm: 1, color: "#888", label: "attention", hub: "attention", count: 3 }],
      more: 0,
    },
  ];
  const legend = (details?: string[]): string =>
    renderToStaticMarkup(
      h(GraphLegend, {
        t: STRINGS.ko,
        galaxies,
        isolated: null,
        onIsolate: () => undefined,
        encoding: { question: "orphans", layout: "galaxy", hasSubject: false },
        override: new Map(),
        setOverride: () => undefined,
        details,
      }),
    );

  it("folds the graph's counts under 자세히 in the pinned key", () => {
    const html = legend(["노트 12 · 연결 30", "보관된 대화 40건은 제외"]);
    const details = html.slice(html.indexOf("<details"));
    expect(details).toContain(`<summary>${STRINGS.ko.gr_details}</summary>`);
    expect(details).toContain("노트 12 · 연결 30");
    expect(details).toContain("보관된 대화 40건은 제외");
    expect(STRINGS.ko.gr_details).toBe("자세히");
  });

  it("has no empty disclosure when there is nothing to tell", () => {
    expect(legend()).not.toContain("<details");
  });
});
