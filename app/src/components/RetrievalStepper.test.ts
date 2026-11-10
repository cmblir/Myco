import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RetrievalStepper from "./RetrievalStepper";
import { STRINGS } from "../lib/i18n";
import { traceOf } from "../lib/ladder";
import type { NearMiss, ScoredChunk } from "../lib/ipc";

const hit: ScoredChunk = {
  page: "wiki/note.md",
  stem: "note",
  section: 0,
  text: "A source passage.",
  score: 0.5,
  similarity: 0.7,
};
const misses: NearMiss[] = Array.from({ length: 4 }, (_, i) => ({
  page: `wiki/${i}.md`,
  tier: "note",
  score_final: 0.1,
  similarity: 0.3,
}));

describe("RetrievalStepper response statistics", () => {
  it.each(["en", "ko", "ja"] as const)(
    "keeps statistics inside collapsed details in %s",
    (lang) => {
      const t = STRINGS[lang];
      const html = renderToStaticMarkup(
        h(RetrievalStepper, {
          t,
          lang,
          id: "trace-case",
          archivedOn: false,
          trace: traceOf(
            { hits: [hit], nearMisses: misses, floor: 0.42 },
            0,
            12,
          ),
        }),
      );
      const buttonArea = html.slice(0, html.indexOf('<div id="trace-case"'));
      expect(buttonArea).toContain('aria-expanded="false"');
      expect(buttonArea).toContain('aria-controls="trace-case"');
      expect(buttonArea).not.toContain(t.q_trace_candidates);
      expect(buttonArea).not.toContain('class="ask-arr"');
      expect(html).toContain('id="trace-case" class="ask-trace" hidden=""');
      // Zero dense-index pages must not present the real returned chunk count as zero candidates.
      expect(html).toContain(
        `<div class="k">${t.q_trace_candidates}</div><div class="v">0</div>`,
      );
      expect(html).toContain(
        `<div class="k">${t.q_trace_rrf}</div><div class="v">5</div>`,
      );
      expect(html).toContain(
        `<div class="k">${t.q_trace_floor}</div><div class="v">4</div>`,
      );
      expect(html).not.toContain('class="v">−4');
      expect(html).toContain(t.q_trace_params.replace("{floor}", "0.42"));
    },
  );

  it("shows unreported similarity coverage and index status as unknown, not zero", () => {
    const t = STRINGS.ko;
    const html = renderToStaticMarkup(
      h(RetrievalStepper, {
        t,
        lang: "ko",
        id: "unknown-trace",
        archivedOn: true,
        trace: traceOf(
          {
            hits: [hit],
            nearMisses: [
              { page: "wiki/old.md", tier: "note", score_final: 0.1 },
            ],
            floor: 0.42,
          },
          null,
          12,
        ),
      }),
    );
    for (const label of [
      t.q_trace_candidates,
      t.q_trace_bm25,
      t.q_trace_dense,
    ]) {
      expect(html).toContain(
        `<div class="k">${label}</div><div class="v">—</div>`,
      );
    }
    expect(html).toContain(t.q_trace_cold_on_sub);
  });
});
