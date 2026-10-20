// What the spotlight shows for a finished turn (UX S5 item 1). Static markup,
// as ui.test.ts does — the window itself needs the Tauri event bus.
import { createElement as h, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
});
import { SpotlightResult } from "./Spotlight";
import { STRINGS } from "../lib/i18n";

const t = STRINGS.ko;
type Props = Parameters<typeof SpotlightResult>[0];
type Result = Props["result"];
const none = (): undefined => undefined;
const props = (result: Result, more: Partial<Props> = {}): Props => ({
  t,
  result,
  onOpen: none,
  onOpenAsk: none,
  noted: null,
  onNote: none,
  onOpenNoted: none,
  ...more,
});
const render = (result: Result, more: Partial<Props> = {}): string =>
  renderToStaticMarkup(h(SpotlightResult, props(result, more)));

/** The host <button>s in an element tree — what a click would reach. */
function buttons(node: ReactNode): ReactElement<{ onClick?: () => void; children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const own = node.type === "button" ? [node] : [];
  return [...own, ...buttons(node.props.children)];
}

describe("SpotlightResult", () => {
  it("an abstained turn shows the abstain title, not a verbatim quote", () => {
    const html = render({ question: "zzqq", answer: t.q_extractive_empty, abstained: true });
    expect(html).toContain(t.q_abstain_title);
    expect(html).toContain(t.spot_open_ask);
    expect(html).not.toContain(t.q_extractive_label);
    // The body was reindex advice, which is not what happened.
    expect(html).not.toContain("재인덱스");
  });

  it("an abstained turn's button opens the Ask page, where its near misses are", () => {
    const html = render({ question: "zzqq", answer: "", abstained: true });
    expect(html).toContain(`<button type="button"`);
    expect(html).toContain(t.spot_open_ask_btn);
    let opened = 0;
    const tree = SpotlightResult(
      props({ question: "zzqq", answer: "", abstained: true }, { onOpenAsk: () => void (opened += 1) }),
    );
    const btn = buttons(tree).find((b) => b.props.children === t.spot_open_ask_btn);
    btn?.props.onClick?.();
    expect(opened).toBe(1);
  });

  // UX S30: the abstention's next step is the Ask card's, writing the
  // question into today's note; the Ask page keeps the numbers.
  it("an abstained turn offers to write the question down, first and primary", () => {
    const html = render({ question: "주말 등산 코스 추천", answer: "", abstained: true });
    expect(html).toContain(t.q_abstain_note);
    expect(html.indexOf(t.q_abstain_note)).toBeLessThan(html.indexOf(t.spot_open_ask_btn));
    const at = html.indexOf(t.q_abstain_note);
    expect(html.slice(html.lastIndexOf("<button", at), at)).toContain("spotlight-note");
    let wrote = 0;
    const tree = SpotlightResult(
      props({ question: "q", answer: "", abstained: true }, { onNote: () => void (wrote += 1) }),
    );
    buttons(tree).find((b) => b.props.children === t.q_abstain_note)?.props.onClick?.();
    expect(wrote).toBe(1);
    // No receipt before anything is written.
    expect(html).not.toContain(t.home_captured);
  });

  it("once written, the done button itself opens the note the line went into", () => {
    // One sentence, not "적어 두었어요" over a receipt saying "적었어요 [열기]".
    let opened = 0;
    const result = { question: "q", answer: "", abstained: true };
    const noted = { rel: "daily/2026-10-02.md", line: "- 09:05 질문: q" };
    const more = { noted, onOpenNoted: () => void (opened += 1) };
    const html = render(result, more);
    expect(html).toContain(t.q_abstain_noted);
    expect(html).not.toContain(`>${t.q_abstain_note}<`);
    expect(html).not.toContain(t.home_captured);
    const all = buttons(SpotlightResult(props(result, more)));
    const done = all.filter((b) => String(b.props.children).includes(t.q_abstain_noted));
    expect(done).toHaveLength(1);
    expect(String(done[0].props.children)).toContain(t.home_open_daily);
    expect((done[0].props as { "aria-disabled"?: boolean })["aria-disabled"]).toBeFalsy();
    done[0].props.onClick?.();
    expect(opened).toBe(1);
  });

  it("while the write runs, the done button does nothing yet", () => {
    let opened = 0;
    const more = { noted: "" as const, onOpenNoted: () => void (opened += 1) };
    const all = buttons(SpotlightResult(props({ question: "q", answer: "", abstained: true }, more)));
    const done = all.find((b) => String(b.props.children).includes(t.q_abstain_noted));
    expect((done?.props as { "aria-disabled"?: boolean })["aria-disabled"]).toBe(true);
    done?.props.onClick?.();
    expect(opened).toBe(0);
  });

  it("an abstain on a dated question names the period", () => {
    const html = render({
      question: "지난주 zzqq",
      answer: t.q_range_empty,
      abstained: true,
      range: { start: "2026-09-21", end: "2026-09-27" },
    });
    expect(html).toContain(t.q_range_empty);
    expect(html).toContain("2026-09-21");
    expect(html).not.toContain(t.q_abstain_title);
  });

  // ■ on the Ask page stopped the Spotlight's question (UX S36): the Ask
  // page's 멈춤 copy, not a blank answer.
  it("a stopped turn shows 멈춤, not a blank answer", () => {
    const html = render({ question: "q", answer: "", stopped: true });
    expect(html).toContain(t.q_stopped);
    expect(html).toContain(t.q_stopped_sub);
    expect(html).not.toContain(t.spot_hint_open);
  });

  it("quoted passages keep the verbatim label and the answer", () => {
    const html = render({ question: "attention", answer: "> RoPE rotates", extractive: true });
    expect(html).toContain(t.q_extractive_label);
    expect(html).toContain("RoPE rotates");
    expect(html).not.toContain(t.q_abstain_title);
  });
});
