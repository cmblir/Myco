// Home's recent list leads with today's daily note (UX S7), whether or not the
// file exists yet — opening it creates it. Static markup, as ui.test.ts does.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RecentNotes from "./RecentNotes";
import { STRINGS } from "../lib/i18n";
import { today } from "../lib/taskLine";
import { Icon } from "../lib/icons";

const t = STRINGS.en;
const rowNames = (html: string): string[] =>
  [...html.matchAll(/class="recent-row__name"[^>]*>([^<]*)</g)].map((m) =>
    m[1].replace(/&#x27;/g, "'"),
  );

describe("RecentNotes", () => {
  it("puts Today's note first, with a calendar icon, even before it exists", () => {
    const html = renderToStaticMarkup(
      h(RecentNotes, { t, vaultRoot: "/v", entries: [["/v/wiki/a.md", 100]] }),
    );
    expect(rowNames(html)).toEqual([t.sb_today_note, "a"]);
    const calendar = renderToStaticMarkup(
      h(Icon, { name: "calendar", size: 14 }),
    );
    expect(calendar).toContain("<path");
    expect(html.indexOf(calendar)).toBeGreaterThan(-1);
    expect(html.indexOf(calendar)).toBeLessThan(
      html.indexOf("recent-row__name"),
    );
  });

  it("does not list today's note a second time", () => {
    const html = renderToStaticMarkup(
      h(RecentNotes, {
        t,
        vaultRoot: "/v",
        entries: [
          [`/v/daily/${today()}.md`, 200],
          ["/v/wiki/a.md", 100],
        ],
      }),
    );
    expect(rowNames(html)).toEqual([t.sb_today_note, "a"]);
  });

  it("does not say nothing changed when today's note is the change", () => {
    const html = renderToStaticMarkup(
      h(RecentNotes, { t, vaultRoot: "/v", entries: [[`/v/daily/${today()}.md`, 200]] }),
    );
    expect(rowNames(html)).toEqual([t.sb_today_note]);
    expect(html).not.toContain(t.ov_recent_never);
    const empty = renderToStaticMarkup(h(RecentNotes, { t, vaultRoot: "/v", entries: [] }));
    expect(empty).toContain(t.ov_recent_never);
  });

  it("names an opaque session page the way the tree does, its Tidy title once it has one", () => {
    const page = "/v/wiki/source-claude-code-064ddbe4-251d-4da1-8315-da096a5b75ff.md";
    const render = (meta?: Record<string, { title: string }>): string[] =>
      rowNames(
        renderToStaticMarkup(h(RecentNotes, { t, vaultRoot: "/v", entries: [[page, 100]], meta })),
      );
    expect(render()).toEqual([t.sb_today_note, "Claude Code · 064ddbe4"]);
    const title = "서버 띄워봐. · Claude Code · 2026-07-27";
    expect(render({ [page]: { title } })).toEqual([t.sb_today_note, title]);
  });

  it("keeps the full stem of a renamed row in its tooltip, as the tree does", () => {
    const stem = "source-claude-code-064ddbe4-251d-4da1-8315-da096a5b75ff";
    const html = renderToStaticMarkup(
      h(RecentNotes, { t, vaultRoot: "/v", entries: [[`/v/wiki/${stem}.md`, 100]] }),
    );
    expect(html).toContain(`class="recent-row__name" title="${stem}">Claude Code · 064ddbe4<`);
  });

  it("has no Today's note row without a vault", () => {
    const html = renderToStaticMarkup(
      h(RecentNotes, { t, vaultRoot: "", entries: [] }),
    );
    expect(rowNames(html)).toEqual([]);
  });
});
