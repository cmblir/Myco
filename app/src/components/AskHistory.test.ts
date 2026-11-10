// The Ask page's 기록 list (UX S36). Static markup, as AbstainCard.test.ts does.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AskHistory, { HistoryAnswer, scopeChipOf } from "./AskHistory";
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

it("distinguishes model evidence abstention from a search miss in saved history", () => {
 const html = render([{at: NOW, q: "question", a: "", cited: [], abstained: true, abstainReason: "model_evidence"}]);
 expect(html).toContain(t.q_model_evidence_title);
 expect(html).not.toContain(t.q_history_abstained);
});


it("a reopened answer preserves passage omissions inside one citation page and its applied period/scope",()=>{
 const rec:AskRecord={at:NOW,q:"이번 주",a:"Recorded answer [[sessions/work|Work]]",cited:["sessions/work"],scope:"sessions",
  searchContext:{version:1,range:{start:"2026-10-05",end:"2026-10-07"},paths:["sessions/work.md"],activityQuestion:"최근에 한 일",
   packing:{selectedPassages:1,omittedPassages:1,omittedOnIncludedPages:1},activityCoverage:{scannedPages:1,sources:1,incomplete:true}}};
 const html=renderToStaticMarkup(h(HistoryAnswer,{t,lang:"ko",rec,onOpenStem:()=>undefined}));
 expect(html).toContain("Recorded answer");
 expect(html).toContain(t.q_scope_chip.replace("{scope}",t.q_scope_sessions));
 expect(html).toContain(t.q_range_chip.replace("{s}","2026-10-05").replace("{e}","2026-10-07"));
 expect(html).toContain(t.q_history_original_question.replace("{question}","최근에 한 일"));
 expect(html).toContain(t.q_context_packing_limited.replace("{selected}","1").replace("{omitted}","1"));
 expect(html).toContain(t.q_context_packing_same_page.replace("{n}","1"));
 expect(html).toContain("sessions/work.md");
 expect(render([rec])).toContain(t.q_context_packing_badge);
});
it("a reopened period clarification keeps the saved answer even if an older row also has abstained=true",()=>{
 const rec:AskRecord={at:NOW,q:"최근 한 일",a:"어느 기간의 기록을 살펴볼까요?",cited:[],abstained:true,
  searchContext:{version:1,periodClarification:true,activityQuestion:"최근 한 일"}};
 const html=renderToStaticMarkup(h(HistoryAnswer,{t,lang:"ko",rec,onOpenStem:()=>undefined}));
 expect(html).toContain(rec.a);expect(html).toContain(t.q_history_period_needed);
 expect(html).not.toContain(t.q_abstain_title);
 expect(render([rec])).not.toContain(t.q_history_abstained);
});
it("reopens an explicitly unrestricted period without inventing a range or packing verdict",()=>{
 const rec:AskRecord={at:NOW,q:"지난주 상태",a:"Saved answer",cited:[],searchContext:{version:1,rangeIgnored:true}};
 const html=renderToStaticMarkup(h(HistoryAnswer,{t,lang:"ko",rec,onOpenStem:()=>undefined}));
 expect(html).toContain(t.q_range_unrestricted);expect(html).not.toContain("ask-context-coverage");
 expect(html).not.toContain("기간: ");
});

it("reopens model identity and request status separately from the saved answer and preserves unknown legacy rows",()=>{
 const rec:AskRecord={at:NOW,q:"question",a:"Saved answer",cited:[],execution:{version:1,
  selected:{providerId:"ollama",modelId:"requested"},answerKind:"model_response",calls:[{id:"a",purpose:"answer",
   requested:{providerId:"ollama",modelId:"requested"},state:"response_received",identity:{modelId:"reported",source:"provider_response"}}]}};
 const html=renderToStaticMarkup(h(HistoryAnswer,{t,lang:"ko",rec,onOpenStem:()=>undefined}));
 expect(html).toContain("Saved answer");expect(html).toContain("requested");expect(html).toContain("reported");
 expect(html).toContain(t.q_execution_provider_identity);
 const legacy=renderToStaticMarkup(h(HistoryAnswer,{t,lang:"ko",rec:{...rec,execution:undefined},onOpenStem:()=>undefined}));
 expect(legacy).toContain("Saved answer");expect(legacy).toContain(t.q_execution_unknown);
 expect(legacy).not.toContain("requested");expect(legacy).not.toContain("reported");
});
