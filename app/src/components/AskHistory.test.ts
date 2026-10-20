// The Ask page's 기록 list (UX S36). Static markup, as AbstainCard.test.ts does.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AskHistory, { scopeChipOf } from "./AskHistory";
import { STRINGS } from "../lib/i18n";
import type { AskRecord } from "../lib/ipc";

const t = STRINGS.ko;
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const render = (records: AskRecord[], error: string | null = null): string =>
  renderToStaticMarkup(
    h(AskHistory, { t, lang: "ko", records, error, now: NOW, onOpenStem: () => undefined }),
  );

const LOG: AskRecord[] = [
  { at: NOW - 86_400_000, q: "어텐션이 뭐야", scope: "wiki", a: "> 쿼리와 키", cited: ["attention", "transformer"] },
  { at: NOW - 3 * 60_000, q: "주말 등산 코스", a: "", cited: [], abstained: true },
];

describe("AskHistory", () => {
  it("lists past questions newest first, each with when, its notes and its outcome", () => {
    const html = render(LOG);
    expect(html).toContain(t.q_history);
    expect(html.indexOf("주말 등산 코스")).toBeLessThan(html.indexOf("어텐션이 뭐야"));
    expect(html).toContain("3분 전");
    expect(html).toContain("어제");
    expect(html).toContain(t.q_history_cited.replace("{n}", "2"));
    expect(html).toContain(t.q_history_abstained);
    expect(html).toContain(`aria-label="${t.q_history_search}"`);
  });

  it("marks a failed and a stopped turn as such", () => {
    const html = render([
      { at: NOW, q: "a", a: "", cited: [], error: "provider 500" },
      { at: NOW, q: "b", a: "", cited: [], stopped: true },
    ]);
    expect(html).toContain(t.q_history_failed);
    expect(html).toContain(t.q_stopped);
  });

  // Unfolded, a week of questions pushed the question field to the bottom
  // edge of a 700px window on every launch.
  it("starts folded to its one summary line", () => {
    const html = render(LOG);
    expect(html).toMatch(/^<details class="intake-disclosure ask-history"><summary>/);
    expect(html).toContain(`${t.q_history} · 2`);
  });

  it("is absent with nothing asked yet, and says when the log could not be read", () => {
    expect(render([])).toBe("");
    expect(render([], "EACCES")).toContain(t.q_history_load_failed);
  });

  // "Ask this note" (UX S37): a turn over one note names the note, never
  // "Scope: all" — it did not search everything.
  it("a past turn's chip names its note, else its scope", () => {
    expect(scopeChipOf(t, { at: NOW, q: "q", a: "", cited: [], note: { title: "어텐션" } })).toBe(
      t.q_note_scope_chip.replace("{note}", "어텐션"),
    );
    expect(scopeChipOf(t, LOG[0])).toBe(t.q_scope_chip.replace("{scope}", t.q_scope_wiki));
    expect(scopeChipOf(t, LOG[1])).toBeNull();
  });
});
