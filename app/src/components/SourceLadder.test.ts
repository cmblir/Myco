import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
});

import SourceLadder from "./SourceLadder";
import { STRINGS } from "../lib/i18n";
import type { LadderRow } from "../lib/ladder";

const row: LadderRow = {
  page: "wiki/source-codex-12345678-0000-4000-8000-000000000000.md",
  stem: "source-codex-12345678-0000-4000-8000-000000000000",
  tier: "note", similarity: 0.8, quote: "Synthetic evidence.",
  rrf: 0.03, prior: 1, final: 0.03, rankChange: 1, archived: false,
};
const render = (source: LadderRow): string => renderToStaticMarkup(h(SourceLadder, {
  t: STRINGS.ko, id: "synthetic-sources", rows: [source], quoted: 1, floor: 0.42,
  hot: null, onHot: () => undefined, onOpen: () => undefined,
}));

describe("SourceLadder names", () => {
  it("shows readable session names while retaining the source identity for inspection", () => {
    const html = render(row);
    expect(html).toContain('<span class="ask-lstem">Codex · 12345678</span>');
    expect(html).toContain(`title="${row.stem}"`);
  });

  it("keeps an ordinary source name unchanged", () => {
    expect(render({ ...row, stem: "Synthetic planning note", rankChange: 0 }))
      .toContain('<span class="ask-lstem">Synthetic planning note</span>');
  });
});
