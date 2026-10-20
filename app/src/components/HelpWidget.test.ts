import { describe, expect, it } from "vitest";
import { graphShortcuts, helpShortcuts } from "./HelpWidget";
import { STRINGS } from "../lib/i18n";

describe("HelpWidget — the Graph route's own keys", () => {
  it("lists the bare [ / ] rail keys beside ⌘[ / ⌘] Back and Forward", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      const t = STRINGS[lang];
      expect(graphShortcuts(t)).toContainEqual(["[ / ]", t.gr_help_rails]);
    }
  });

  it("gives every row its own label, which keys it", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      for (const route of ["graph", "query", "page:x.md"]) {
        const rows = helpShortcuts(route, STRINGS[lang]);
        expect(new Set(rows.map(([, label]) => label)).size).toBe(rows.length);
      }
    }
    const graph = helpShortcuts("graph", STRINGS.en);
    expect(graph.filter(([key]) => key === "⌘click")).toHaveLength(1);
    // A note's link opens on a plain click (UX S55).
    expect(graph).toContainEqual(["Click", STRINGS.en.hw_sc_live_link]);
    expect(graph.slice(-3)).toEqual(graphShortcuts(STRINGS.en));
  });

  it("names a tap, not arrow keys, for a link on a touch screen (UX S46)", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      const t = STRINGS[lang];
      const rows = helpShortcuts("page:x.md", t, true);
      expect(rows).toContainEqual(["Tap", t.hw_sc_live_link_touch]);
      expect(rows.some(([, label]) => label === t.hw_sc_live_link)).toBe(false);
    }
  });
});
