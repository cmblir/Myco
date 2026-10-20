import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RailTab } from "./GraphRailToggle";
import GraphGaps from "./GraphGaps";
import GraphLegend from "./GraphLegend";
import GraphHelp from "./GraphHelp";
import { STRINGS } from "../lib/i18n";

// Focus return is a browser-only layout effect; the markup is what this checks.
vi.mock("../lib/returnFocus", () => ({ useReturnFocus: vi.fn() }));

const ko = STRINGS.ko;
const en = STRINGS.en;

function gaps(onFold?: () => void): string {
  return renderToStaticMarkup(
    createElement(GraphGaps, {
      t: ko,
      groups: [],
      total: 12,
      selected: null,
      onSelect: vi.fn(),
      onAction: vi.fn(),
      onTidy: vi.fn(),
      onFold,
      closed: {},
      setClosed: vi.fn(),
    }),
  );
}

const galaxy = {
  g: -1,
  label: "",
  color: "#888",
  count: 5,
  more: 2,
  clusters: [
    { cm: 0, label: "alpha", hub: "alpha", color: "#f00", count: 3 },
    { cm: 1, label: "beta", hub: "beta", color: "#0f0", count: 2 },
  ],
};

function legend(onFold?: () => void): string {
  return renderToStaticMarkup(
    createElement(GraphLegend, {
      t: en,
      galaxies: [galaxy],
      isolated: null,
      onIsolate: vi.fn(),
      encoding: { question: "orphans", layout: "galaxy", hasSubject: false },
      onFold,
      override: new Map(),
      setOverride: vi.fn(),
    }),
  );
}

describe("folding a rail from its head", () => {
  it("gives the gaps rail a labelled, expanded chevron beside 정리", () => {
    const html = gaps(vi.fn());
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="연결이 빠진 곳 접기"');
    expect(html).toContain('data-rail-toggle="gaps"');
    expect(html).toContain(`>${ko.tidy_btn}<`);
  });

  it("shows no chevron where the page offers no fold", () => {
    expect(gaps()).not.toContain("data-rail-toggle");
  });

  it("gives the legend the same chevron, and counts its topics in the head", () => {
    const html = legend(vi.fn());
    expect(html).toContain('aria-label="Collapse Legend"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-rail-toggle="legend"');
    // two listed clusters + two behind "+2 more"
    expect(html).toContain('<span class="u-rail__count">4</span>');
  });
});

describe("RailTab — the folded rail at the stage's edge", () => {
  it("names what it expands, reports itself collapsed, and shows the count", () => {
    const html = renderToStaticMarkup(
      createElement(RailTab, { t: ko, rail: "gaps", count: 12, onOpen: vi.fn() }),
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="연결이 빠진 곳 펼치기 · 12"');
    expect(html).toContain('title="연결이 빠진 곳 펼치기 ([)"');
    expect(html).toContain('data-rail-toggle="gaps"');
    expect(html).toContain(">12<");
  });

  it("sits on the legend's own edge, with its own key", () => {
    const html = renderToStaticMarkup(
      createElement(RailTab, { t: en, rail: "legend", count: 4, onOpen: vi.fn() }),
    );
    expect(html).toContain("graph-railtab--legend");
    expect(html).toContain('title="Expand Legend (])"');
  });
});

describe("GraphHelp", () => {
  it("lists the [ and ] rail keys", () => {
    const html = renderToStaticMarkup(createElement(GraphHelp, { t: ko, onClose: vi.fn() }));
    expect(html).toContain("<kbd>[</kbd>");
    expect(html).toContain("<kbd>]</kbd>");
    expect(html).toContain(ko.gr_help_rails);
  });
});

describe("i18n", () => {
  it("has the rail strings in every language", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      const s = STRINGS[lang];
      for (const key of ["gr_rail_fold", "gr_rail_open"] as const) expect(s[key]).toContain("{name}");
      expect(s.gr_panels.length).toBeGreaterThan(0);
      expect(s.gr_help_rails.length).toBeGreaterThan(0);
    }
  });
});

// PageGraph unmounts a folded rail (the frame frees its column only when the
// rail prop is absent), so what the user collapsed inside it lives in the page
// and comes back with the rail.
describe("a folded rail comes back as the user left it", () => {
  const expanded = (html: string): string[] =>
    [...html.matchAll(/class="u-rail__grouphead" aria-expanded="(true|false)"/g)].map((m) => m[1]);

  it("draws the gaps groups from the page's collapsed set", () => {
    const html = renderToStaticMarkup(
      createElement(GraphGaps, {
        t: en,
        groups: [
          { key: "orphans", label: "Orphans", ids: ["/v/wiki/a.md"], actions: ["open"] },
          { key: "missing", label: "Missing", ids: ["ghost:b"], actions: ["want"] },
        ],
        total: 2,
        selected: null,
        onSelect: vi.fn(),
        onAction: vi.fn(),
        closed: { orphans: true },
        setClosed: vi.fn(),
      }),
    );
    expect(expanded(html)).toEqual(["false", "true"]);
  });

  it("draws the legend's galaxies from the page's overrides, keyed by galaxy id", () => {
    const gx = (g: number, label: string) => ({ ...galaxy, g, label });
    const html = renderToStaticMarkup(
      createElement(GraphLegend, {
        t: en,
        galaxies: [gx(3, "wiki"), gx(5, "notes")],
        isolated: null,
        onIsolate: vi.fn(),
        encoding: { question: "orphans", layout: "galaxy", hasSubject: false },
        override: new Map([
          [3, false],
          [5, true],
        ]),
        setOverride: vi.fn(),
      }),
    );
    // By default only the first galaxy is open; the overrides flip both.
    expect(expanded(html)).toEqual(["false", "true"]);
  });
});
