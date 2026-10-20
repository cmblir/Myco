// Home's "today's connections" line (UX S40). Static markup, as RecentNotes.test.ts does.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DayConnectionsLine } from "./DayConnections";
import { STRINGS } from "../lib/i18n";

const t = STRINGS.en;
const names = (html: string): string[] =>
  [...html.matchAll(/class="day-links__note"[^>]*>([^<]*)</g)].map((m) => m[1]);

describe("DayConnectionsLine", () => {
  it("names the first new pair as note links, the rest as a count, and new citations", () => {
    const html = renderToStaticMarkup(
      h(DayConnectionsLine, {
        t,
        pairs: [
          ["wiki/attention.md", "wiki/transformer.md"],
          ["wiki/a.md", "wiki/b.md"],
        ],
        cites: 3,
        nameOf: (rel: string) => rel.replace(/^wiki\/|\.md$/g, ""),
        open: () => undefined,
      }),
    );
    expect(names(html)).toEqual(["attention", "transformer"]);
    expect(html).toContain(t.home_links_more.replace("{n}", "1"));
    expect(html).toContain(t.home_links_cites.replace("{n}", "3"));
    expect(html).toContain(t.home_links_updated);
  });

  it("says when nothing new is linked yet, and when it updates", () => {
    const html = renderToStaticMarkup(
      h(DayConnectionsLine, { t, pairs: [], cites: 0, nameOf: String, open: () => undefined }),
    );
    expect(names(html)).toEqual([]);
    expect(html).toContain(t.home_links_none);
    expect(html).toContain(t.home_links_updated);
  });

  it("shows new citations alone when no pair is new", () => {
    const html = renderToStaticMarkup(
      h(DayConnectionsLine, { t, pairs: [], cites: 2, nameOf: String, open: () => undefined }),
    );
    expect(html).toContain(t.home_links_cites.replace("{n}", "2"));
    expect(html).not.toContain(t.home_links_none);
  });
});
