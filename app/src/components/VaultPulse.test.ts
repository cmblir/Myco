import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import VaultPulse from "./VaultPulse";
import { STRINGS } from "../lib/i18n";

describe("VaultPulse statistics", () => {
  const props = {
    t: STRINGS.en,
    pages: 1234,
    links: 56,
    buckets: { authored: [0, 1, 0, 0, 0, 0, 0], ingested: [0, 0, 2, 0, 0, 0, 0] },
  };

  it("keeps figures and all seven day controls without mounting a canvas", () => {
    const html = renderToStaticMarkup(h(VaultPulse, props));
    expect(html).not.toContain("<canvas");
    expect(html.match(/class="vp-figure"/g)).toHaveLength(3);
    expect(html.match(/class="vp-day"/g)).toHaveLength(7);
    expect(html).toContain(STRINGS.en.ov_stats_pages);
    expect(html).toContain(STRINGS.en.ov_stats_links);
  });

  it("retains a readable empty week rather than hiding its controls", () => {
    const html = renderToStaticMarkup(h(VaultPulse, {
      ...props,
      pages: 0,
      links: 0,
      buckets: { authored: Array(7).fill(0), ingested: Array(7).fill(0) },
    }));
    expect(html.match(/class="vp-day"/g)).toHaveLength(7);
    expect(html.match(/class="vp-value">0/g)).toHaveLength(3);
    expect(html).toContain('aria-live="polite"');
  });
});
