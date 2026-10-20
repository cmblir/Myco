// The abstain card for a dated question names the period it searched and
// offers to drop it (UX S5 item 4). Static markup, as ui.test.ts does.
import { createElement as h, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AbstainCard from "./AbstainCard";
import { STRINGS } from "../lib/i18n";

const t = STRINGS.ko;
const noop = (): undefined => undefined;

/** The host <button>s in an element tree — what a click would reach. */
function buttons(node: ReactNode): ReactElement<{ onClick?: () => void; children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const own = node.type === "button" ? [node] : [];
  return [...own, ...buttons(node.props.children)];
}
interface Reasks {
  onWiden?: () => void;
  onDropRange?: () => void;
}
const card = (range?: { start: string; end: string }, reasks: Reasks = { onWiden: noop }): string =>
  renderToStaticMarkup(
    h(AbstainCard, {
      t,
      id: "a",
      indexedPages: 51,
      floor: 0.42,
      misses: [],
      harvested: false,
      noted: false,
      ...reasks,
      range,
    }),
  );

describe("AbstainCard", () => {
  it("names the period instead of the whole index for a dated question", () => {
    // Asked over every scope: dropping the period is the only way wider.
    const html = card({ start: "2026-09-14", end: "2026-09-20" }, { onDropRange: noop });
    expect(html).toContain(t.q_range_empty);
    expect(html).not.toContain(t.q_abstain_title);
    expect(html).toContain("2026-09-14");
    expect(html).toContain("2026-09-20");
    expect(html).not.toContain("51");
    expect(html).toContain(t.q_abstain_widen_range);
    expect(html).not.toContain(t.q_abstain_widen);
  });

  it("a dated question in a narrower scope can widen with its period or drop it", () => {
    const html = card({ start: "2026-09-14", end: "2026-09-20" }, { onWiden: noop, onDropRange: noop });
    expect(html).toContain(t.q_abstain_widen);
    expect(html).toContain(t.q_abstain_widen_range);
    // Dropping the period is the primary way forward (audit A11): first.
    expect(html.indexOf(t.q_abstain_widen_range)).toBeLessThan(html.indexOf(t.q_abstain_widen));
  });

  it("without a period, speaks of the indexed pages and widens the scope", () => {
    const html = card(undefined, { onWiden: noop, onDropRange: noop });
    expect(html).toContain(t.q_abstain_title);
    expect(html).toContain("51");
    expect(html).toContain(t.q_abstain_widen);
    expect(html).not.toContain(t.q_abstain_widen_range);
  });

  it("explains a known scope limit without claiming that no note contains related ideas", () => {
    const explanation = "The conversation scope cannot establish wiki links. Search wider.";
    const html = renderToStaticMarkup(h(AbstainCard, {
      t, id: "scope-limit", indexedPages: 3, floor: 0.42, misses: [],
      harvested: false, noted: false, explanation, onWiden: noop,
    }));
    expect(html).toContain(explanation);
    expect(html).not.toContain(t.q_abstain_sub_none);
    expect(html).toContain(t.q_abstain_widen);
  });
});

// UX S30: the card reads as a next step, not an error. Plain words up top,
// the numbers under 자세히, and writing the question down as the main action.
describe("AbstainCard in plain words (S30)", () => {
  const MISS = { page: "wiki/attention.md", similarity: 0.4, score_final: 0.01, tier: "note" } as const;
  const base = {
    t,
    id: "a",
    indexedPages: 51,
    floor: 0.42,
    misses: [MISS],
    harvested: false,
    noted: false,
    onNote: noop,
    onWiden: noop,
    onHarvest: noop,
  };
  const render = (props: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(h(AbstainCard, { ...base, ...props } as Parameters<typeof AbstainCard>[0]));
  const before = (html: string, part: string): string => html.slice(0, html.indexOf(part));

  it("says what happened in the owner's words", () => {
    expect(t.q_abstain_title).toBe("내 노트에서 이 내용을 찾지 못했어요");
    expect(t.q_abstain_sub).toBe("비슷한 노트는 있었지만 답이 될 만큼 가깝지 않았어요");
    // "오늘의 노트", the daily note's one name (sidebar, Home, the toast).
    expect(t.q_abstain_note).toBe("이 질문을 오늘의 노트에 적어 두기");
    expect(t.q_abstain_widen).toBe("범위 넓혀 다시 찾기");
    expect(t.q_abstain_harvest).toBe("나중에 채울 질문으로 표시");
  });

  it("the harvest receipt says only what the harvest did", () => {
    // It sits under "적어 두었어요", whose write may have created today's
    // note, and the first harvest creates .myco/eval/misses.jsonl: a "no
    // file was created" there is wrong twice.
    expect(t.q_abstain_receipt).toBe("나중에 채울 질문 목록에 남겼어요");
    for (const lang of ["en", "ko", "ja"] as const)
      expect(STRINGS[lang].q_abstain_receipt).not.toMatch(/file|파일|ファイル/i);
  });

  it("keeps the page count, the floor and the near misses under 자세히", () => {
    const html = render();
    const top = before(html, "<details");
    expect(top).toContain(t.q_abstain_title);
    expect(top).toContain(t.q_abstain_sub);
    for (const n of ["51", "0.42", "0.400", "wiki/attention.md"]) expect(top).not.toContain(n);
    const details = html.slice(html.indexOf("<details"));
    expect(details).toContain(`<summary>${t.q_abstain_details}</summary>`);
    for (const n of ["51", "0.42", "0.400", "wiki/attention.md"]) expect(details).toContain(n);
  });

  it("does not claim a similar note when none came back", () => {
    const html = render({ misses: [] });
    expect(html).toContain(t.q_abstain_sub_none);
    expect(html).not.toContain(t.q_abstain_sub);
  });

  it("offers write it down first and primary, search wider next, mark for later as a text button", () => {
    const html = render();
    const note = html.indexOf(t.q_abstain_note);
    const widen = html.indexOf(t.q_abstain_widen);
    const mark = html.indexOf(t.q_abstain_harvest);
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(widen);
    expect(widen).toBeLessThan(mark);
    const tag = (at: number): string => html.slice(html.lastIndexOf("<button", at), at);
    expect(tag(note)).toContain("btn-primary");
    expect(tag(widen)).not.toContain("btn-primary");
    expect(tag(mark)).toContain("btn-ghost");
  });

  it("while the write runs, says so and stays focusable", () => {
    const html = render({ noted: true });
    expect(html).toContain(t.q_abstain_noted);
    expect(html).not.toContain(t.q_abstain_note);
    const at = html.indexOf(t.q_abstain_noted);
    const tag = html.slice(html.lastIndexOf("<button", at), at);
    expect(tag).toContain('aria-disabled="true"');
    expect(tag).not.toContain("disabled=\"\"");
  });

  it("once written, the done button opens the note, so the card is never a dead end", () => {
    // A done primary that looked live and did nothing, with no Open on the
    // card once the toast left, was the review's finding: it opens now.
    let opened = 0;
    const props = { noted: true, onOpenNoted: () => void (opened += 1) };
    const html = render(props);
    const at = html.indexOf(t.q_abstain_noted);
    const end = html.indexOf("</button>", at);
    expect(html.slice(at, end)).toContain(t.home_open_daily);
    expect(html.slice(html.lastIndexOf("<button", at), at)).not.toContain("aria-disabled");
    const done = buttons(
      AbstainCard({ ...base, ...props } as Parameters<typeof AbstainCard>[0]),
    ).find((b) => String(b.props.children).includes(t.q_abstain_noted));
    done?.props.onClick?.();
    expect(opened).toBe(1);
  });

  it("has nothing to write down for a follow-up", () => {
    // A pronoun question ("그건 왜?") means nothing alone in a daily note.
    expect(render({ onNote: undefined })).not.toContain(t.q_abstain_note);
  });
});
