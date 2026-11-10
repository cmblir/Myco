// "Not what you expected? Log it" keeps keyboard focus once pressed: a
// `disabled` button drops it to <body> in Chromium and WebKit alike, so the
// logged state is aria-disabled. Static markup, as ui.test.ts does.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { createElement as h } from "react";
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
import PageQuery, { ExtractiveAnswer, GuidedQuestionPicker, MissButton, ProjectPicker } from "./PageQuery";
import type { WorkstreamChoice } from "../lib/queryWorkstreams";
import { STRINGS } from "../lib/i18n";
import { DEFAULT_TIER_WEIGHTS } from "../lib/extractive";
import { ipc, type AgentVaultSession, type MycoSettings, type ScoredChunk } from "../lib/ipc";
import { roleFixture, selectedRolesFixture } from "../lib/modelRoles.testSupport";
import { BUILTIN_CHAT_MODEL, BUILTIN_MODEL } from "../lib/providers";
import { useQueryStore, type ChatTurn } from "../stores/queryStore";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import * as queryModule from "../stores/queryStore";
import * as vaultModule from "../stores/vaultStore";
import * as uiModule from "../stores/uiStore";
import * as settingsModule from "../stores/settingsStore";

const t = STRINGS.ko;

describe("guided question choices", () => {
  const picker = (selected: boolean, disabled = false): string => renderToStaticMarkup(h(GuidedQuestionPicker, {
    lang: "ko", intent: selected ? "decision" : null,
    subject: "가상 항해 일지", asOf: "2026-10-15", disabled,
    onIntent: () => undefined, onSubject: () => undefined,
    onAsOf: () => undefined, onSubmit: () => undefined,
  }));

  it("offers five explicit task choices and a free-question escape", () => {
    const html = picker(false);
    for (const label of ["어디까지 했지?", "왜 이렇게 결정했지?", "남은 작업은?", "전에 이야기한 내용 찾기", "설명해줘", "직접 질문하기"])
      expect(html).toContain(label);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).not.toContain('type="date"');
  });

  it("shows the selected task with a named subject and optional historical cutoff", () => {
    const html = picker(true);
    expect(html).toContain('aria-pressed="true">왜 이렇게 결정했지?');
    expect(html).toContain("프로젝트·주제");
    expect(html).toContain('value="가상 항해 일지"');
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-10-15"');
    expect(html).toContain("기준일 (선택)");
    expect(html).toContain("선택한 자료 범위 안에서 찾습니다.");
    expect(picker(true, true)).toContain('fieldset class="ask-guided" disabled=""');
  });
});

// Synthetic projects only.
const choice = (key: string, title: string, conversations: number, suggested = false): WorkstreamChoice =>
  ({ key, title, subject: title, last: Date.parse("2026-11-02T01:00:00Z") / 1000, conversations, suggested });
const PROJECTS = [choice("prj_halo", "Halo", 130, true), choice("nimbus", "Nimbus", 208), choice("kestrel", "Kestrel Lab", 4)];
const MANY = [...PROJECTS, ...["Lyra", "Vega", "Orion", "Zephyr", "Atlas"].map((title) => choice(title.toLowerCase(), title, 2))];

interface Rendered {
  type: unknown;
  props: { children?: unknown; type?: string; onKeyDown?: (event: unknown) => void; onClick?: () => void };
}
/** Every element in a rendered tree that `match` accepts. */
function findAll(node: unknown, match: (element: Rendered) => boolean): Rendered[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, match));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Rendered;
  return [...(match(element) ? [element] : []), ...findAll(element.props.children, match)];
}
const enter = (isComposing = false) => ({ key: "Enter", nativeEvent: { key: "Enter", isComposing, keyCode: isComposing ? 229 : 13 },
  preventDefault: vi.fn() });

describe("guided project picker", () => {
  const picked = (intent: "progress" | "explain" | "decision", projects: WorkstreamChoice[] | null, projectFilter = "") =>
    renderToStaticMarkup(h(GuidedQuestionPicker, {
      lang: "ko", intent, subject: "", asOf: "", disabled: false, projects, projectFilter,
      onProjectFilter: () => undefined, onProject: () => undefined,
      onIntent: () => undefined, onSubject: () => undefined, onAsOf: () => undefined, onSubmit: () => undefined,
    }));

  it.each(["wiki", "sessions", "all"] as const)("discloses the project evidence scope before submission: %s", (projectScope) => {
    const html = renderToStaticMarkup(h(GuidedQuestionPicker, {
      lang: "en", intent: "progress", subject: "", asOf: "", disabled: false,
      projects: PROJECTS, projectScope, onProject: () => undefined,
      onIntent: () => undefined, onSubject: () => undefined, onAsOf: () => undefined, onSubmit: () => undefined,
    }));
    expect(html).toContain('id="ask-project-scope"');
    expect(html).toContain(projectScope === "wiki" ? "current scope is your notes" : "imported conversations");
    expect(html.indexOf('id="ask-project-scope"')).toBeLessThan(html.indexOf('class="ask-guided__projects"'));
  });

  it("shows the projects as buttons with their last activity and conversation count, the suggested one marked", () => {
    const html = picked("progress", PROJECTS);
    expect(html).toContain('role="group" aria-labelledby="ask-guided-projects"');
    expect(html).toContain('<span id="ask-guided-projects" class="ask-guided__projects-label">프로젝트 고르기</span>');
    const last = new Date("2026-11-02T01:00:00Z");
    const date = new Intl.DateTimeFormat("ko", last.getFullYear() === new Date().getFullYear()
      ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" }).format(last);
    expect(html).toContain('<button type="button" class="btn ask-guided__project"><span class="ask-guided__project-title">Halo</span> ' +
      `<span class="ask-guided__suggested">추천</span> <span class="ask-guided__project-meta">마지막 활동 ${date} · 대화 130건</span></button>`);
    expect(html.match(/ask-guided__suggested/g)).toHaveLength(1);
    expect(html.match(/class="btn ask-guided__project"/g)).toHaveLength(3);
    // A few projects need no filter; the subject field for a topic waits
    // behind a button while projects are offered.
    expect(html).not.toContain('type="search"');
    expect(html).toContain('<button type="button" class="btn btn-ghost ask-guided__type">다른 주제를 직접 입력</button>');
    expect(html).not.toContain("프로젝트·주제");
  });

  it("shows six projects and a filter for the rest, and filters by title", () => {
    const html = picked("progress", MANY);
    expect(html.match(/class="btn ask-guided__project"/g)).toHaveLength(6);
    expect(html).toContain('<input type="search" class="input ask-guided__filter" aria-label="프로젝트 찾기" placeholder="이름으로 찾기" value=""/>');
    expect(html).not.toContain("Atlas");
    const found = picked("progress", MANY, "atl");
    expect(found.match(/class="btn ask-guided__project"/g)).toHaveLength(1);
    expect(found).toContain("Atlas");
    const none = picked("progress", MANY, "zzz");
    expect(none).toContain('role="status"');
    // No project matches: the subject field comes back without the button.
    expect(none).toContain("프로젝트·주제");
    expect(none).not.toContain("ask-guided__type");
  });

  it("picks with a click, or with Enter in the filter when it leaves one project, never mid-composition", () => {
    const onPick = vi.fn();
    const tree = (filter: string) => ProjectPicker({ lang: "ko", choices: MANY, filter, onFilter: () => undefined, onPick });
    const field = (filter: string) => findAll(tree(filter), (element) => element.type === "input")[0];
    field("ves").props.onKeyDown?.(enter());
    expect(onPick).not.toHaveBeenCalled();
    field("atl").props.onKeyDown?.(enter(true));
    expect(onPick).not.toHaveBeenCalled();
    const key = enter();
    field("atl").props.onKeyDown?.(key);
    expect(onPick).toHaveBeenCalledWith(MANY.at(-1));
    expect(key.preventDefault).toHaveBeenCalled();
    // Two projects hold "a": Enter picks neither.
    field("a").props.onKeyDown?.(enter());
    expect(onPick).toHaveBeenCalledOnce();
    const buttons = findAll(tree(""), (element) => element.type === "button");
    expect(buttons.map((button) => button.props.type)).toEqual(Array(6).fill("button"));
    buttons[1].props.onClick?.();
    expect(onPick).toHaveBeenLastCalledWith(MANY[1]);
  });

  it("keeps today's subject field alone without facts, and for questions not about one project", () => {
    for (const html of [picked("progress", null), picked("progress", [])]) {
      expect(html).not.toContain("ask-guided__projects");
      expect(html).toContain("프로젝트·주제");
      expect(html).toContain('type="date"');
    }
  });

  it("asks explain without a cutoff date", () => {
    const html = picked("explain", PROJECTS);
    expect(html).toContain('aria-pressed="true">설명해줘');
    expect(html).toContain("ask-guided__projects");
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain("ask-guided-hint");
  });
});

const render = (harvested: boolean): string =>
  renderToStaticMarkup(h(MissButton, { t, harvested, onLog: () => undefined }));

describe("MissButton", () => {
  it("logged, reads as its receipt and stays focusable", () => {
    const html = render(true);
    expect(html).toContain(`✓ ${t.q_miss_done}`);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/\sdisabled=""/);
  });

  it("before logging, is a plain live button", () => {
    const html = render(false);
    expect(html).toContain(t.q_miss_btn);
    expect(html).not.toContain('aria-disabled="true"');
  });
});

// UX S32: an answer is one passage you read and the rest you open. Five
// passages at the answer's serif size made one answer ~2,950px at 1280.

const hit = (n: number, text: string): ScoredChunk => ({
  page: `wiki/note-${n}.md`,
  stem: `note-${n}`,
  section: 0,
  text,
  score: 1 - n / 10,
  similarity: 0.8 - n / 100,
});
const answer = (hits: ScoredChunk[]): string =>
  renderToStaticMarkup(
    h(ExtractiveAnswer, {
      t,
      id: "ask-turn-0",
      turn: { q: "q", a: "a", extractive: true, hits },
      weights: DEFAULT_TIER_WEIGHTS,
      onOpenByStem: () => undefined,
      onOpenPage: () => undefined,
      onQuote: () => undefined,
    }),
  );
const FIVE = [1, 2, 3, 4, 5].map((n) => hit(n, `passage number ${n} body`));

describe("Ask model options", () => {
  it.each([BUILTIN_CHAT_MODEL, BUILTIN_MODEL])("describes the selected local model %s accurately", (model) => {
    const settingsHook = settingsModule.useSettingsStore;
    // This static fixture supplies only the settings consumed by PageQuery.
    const state = { ...settingsHook.getState(), settings: {
      query_provider: "builtin-local", query_model: model,
      model_roles: selectedRolesFixture({ ask: { providerId: "builtin-local", modelId: model } }),
    } as MycoSettings };
    const hook = vi.spyOn(settingsModule, "useSettingsStore").mockImplementation(Object.assign(
      (selector: (value: typeof state) => unknown) => selector(state), settingsHook,
    ) as typeof settingsHook);
    Object.assign(hook, settingsHook);
    try {
      const html = renderToStaticMarkup(h(PageQuery, { t }));
      if (model === BUILTIN_CHAT_MODEL) {
        expect(html).toContain(t.q_via.replace("{provider}", "builtin-local").replace("{model}", model));
        expect(html).toContain(t.q_builtin_note);
        expect(html).not.toContain(t.q_via_retrieval);
        expect(html).not.toContain(t.q_builtin_extractive_note);
      } else {
        expect(html).toContain(t.q_via_retrieval);
        expect(html).toContain(t.q_builtin_extractive_note);
        expect(html).not.toContain(t.q_builtin_note);
      }
    } finally { hook.mockRestore(); }
  });
});

it.each([false, true])("renders locally synthesized prose with model provenance and activity coverage when requested (%s)", (activity) => {
  const previousVault = useVaultStore.getState();
  const previousQuery = useQueryStore.getState();
  const previousUI = useUIStore.getState();
  const queryHook = useQueryStore, vaultHook = useVaultStore, uiHook = useUIStore;
  const hooks: { mockRestore: () => void }[] = [];
  try {
    useVaultStore.setState({ currentVault: { path: "/synthetic", name: "Synthetic vault" }, adjacency: null, fileTree: [] });
    useUIStore.setState({ lang: "ko", route: "query" });
    useQueryStore.setState({ turns: [{ q: "Synthetic question", a: "SYN-GENERATED-ANSWER [[wiki/note-1|note-1]]",
      searchContext:{version:1,packing:{selectedPassages:2,omittedPassages:1,omittedOnIncludedPages:1}},
      localModel: "qwen3.5-4b-q4_k_m", ...(activity
        ? { range: { start: "2026-09-26", end: "2026-10-04" }, activityCoverage: { scannedPages: 24, sources: 2, incomplete: true } }
        : { hits: [hit(1, "SYN-RAW-PASSAGE")] }), extractive: false, scope: "wiki" }],
    busy: false, stage: null, history: [] });
    // SSR uses Zustand's initial snapshot. For this static client-state fixture
    // selectors read the live synthetic state; no subscriptions or IPC run.
    const querySpy = vi.spyOn(queryModule, "useQueryStore").mockImplementation(Object.assign(
      (selector: (state: ReturnType<typeof useQueryStore.getState>) => unknown) => selector(queryHook.getState()), queryHook,
    ) as typeof useQueryStore);
    const vaultSpy = vi.spyOn(vaultModule, "useVaultStore").mockImplementation(Object.assign(
      (selector: (state: ReturnType<typeof useVaultStore.getState>) => unknown) => selector(vaultHook.getState()), vaultHook,
    ) as typeof useVaultStore);
    const uiSpy = vi.spyOn(uiModule, "useUIStore").mockImplementation(Object.assign(
      (selector: (state: ReturnType<typeof useUIStore.getState>) => unknown) => selector(uiHook.getState()), uiHook,
    ) as typeof useUIStore);
    Object.assign(querySpy, queryHook);
    Object.assign(vaultSpy, vaultHook);
    Object.assign(uiSpy, uiHook);
    hooks.push(querySpy, vaultSpy, uiSpy);
    const html = renderToStaticMarkup(h(PageQuery, { t }));
    expect(html).toContain("SYN-GENERATED-ANSWER");
    expect(html).toContain("qwen3.5-4b-q4_k_m");
    expect(html).toContain(t.s_provider_kind_local);
    expect(html).toContain('data-link="wiki/note-1"');
    expect(html).not.toContain("SYN-RAW-PASSAGE");
    expect(html).not.toContain('class="ask-split"');
    expect(html).toContain(t.q_copy_answer);
    expect(html).toContain(t.q_context_packing_limited.replace("{selected}","2").replace("{omitted}","1"));
    expect(html).toContain(t.q_context_packing_same_page.replace("{n}","1"));
    if (activity) {
      expect(html).toContain(t.q_range_chip.replace("{s}", "2026-09-26").replace("{e}", "2026-10-04"));
      expect(html).toContain(t.q_activity_coverage.replace("{scanned}", "24").replace("{sources}", "2"));
      expect(html).toContain(t.q_activity_limited);
    } else { expect(html).not.toContain('data-testid="ask-activity-coverage"'); }
  } finally {
    for (const hook of hooks) hook.mockRestore();
    useVaultStore.setState(previousVault);
    useQueryStore.setState(previousQuery);
    useUIStore.setState(previousUI);
  }
});

describe("Ask retrieval failure recovery", () => {
  const renderTurn = (turn: ChatTurn, lang: "en" | "ko" | "ja"): string => {
    const previousVault = useVaultStore.getState();
    const previousQuery = useQueryStore.getState();
    const previousUI = useUIStore.getState();
    const queryHook = useQueryStore, vaultHook = useVaultStore, uiHook = useUIStore;
    const hooks: { mockRestore: () => void }[] = [];
    try {
      useVaultStore.setState({ currentVault: { path: "/synthetic", name: "Synthetic vault" },
        isOpeningVault: false, adjacency: null, fileTree: [] });
      useUIStore.setState({ lang, route: "query" });
      useQueryStore.setState({ turns: [turn], busy: false, stage: null, history: [] });
      // Static client-state rendering only; no native search or generation runs.
      const querySpy = vi.spyOn(queryModule, "useQueryStore").mockImplementation(Object.assign(
        (selector: (state: typeof previousQuery) => unknown) => selector(queryHook.getState()), queryHook,
      ) as typeof queryHook);
      const vaultSpy = vi.spyOn(vaultModule, "useVaultStore").mockImplementation(Object.assign(
        (selector: (state: typeof previousVault) => unknown) => selector(vaultHook.getState()), vaultHook,
      ) as typeof vaultHook);
      const uiSpy = vi.spyOn(uiModule, "useUIStore").mockImplementation(Object.assign(
        (selector: (state: typeof previousUI) => unknown) => selector(uiHook.getState()), uiHook,
      ) as typeof uiHook);
      Object.assign(querySpy, queryHook);
      Object.assign(vaultSpy, vaultHook);
      Object.assign(uiSpy, uiHook);
      hooks.push(querySpy, vaultSpy, uiSpy);
      return renderToStaticMarkup(h(PageQuery, { t: STRINGS[lang] }));
    } finally {
      for (const hook of hooks) hook.mockRestore();
      useVaultStore.setState(previousVault);
      useQueryStore.setState(previousQuery);
      useUIStore.setState(previousUI);
    }
  };
  it.each(["en", "ko", "ja"] as const)("shows topic clarification without claiming failed search (%s)", lang => {
    const text=STRINGS[lang].q_recall_topic_needed;
    const html=renderTurn({q:"전에 이야기한 그 내용 찾아줘.",a:text,abstained:true,needsClarification:true,followUp:true},lang);
    expect(html).toContain(text);
    expect(html).not.toContain(STRINGS[lang].q_abstain_title);
    expect(html).not.toContain(STRINGS[lang].q_abstain_details);
  });
  const textMarkup = (text: string): string => renderToStaticMarkup(h("span", null, text)).slice(6, -7);

  it.each([
    ["en", "index_stale"], ["en", "retrieval_failed"],
    ["ko", "index_stale"], ["ko", "retrieval_failed"],
    ["ja", "index_stale"], ["ja", "retrieval_failed"],
  ] as const)("keeps %s %s actionable without claiming a successful answer", (lang, code) => {
    const strings = STRINGS[lang];
    const copy = queryModule.askCopy(strings);
    const html = renderTurn({ q: "Synthetic failed question", a: "", scope: "wiki",
      error: code === "index_stale" ? copy.extractiveStale : copy.extractiveFailed,
      activityFailure: code, stale: code === "index_stale", retrievalFailed: code === "retrieval_failed" }, lang);
    expect(html).toContain(textMarkup(code === "index_stale" ? copy.extractiveStale : copy.extractiveFailed));
    expect(html).toContain(strings.q_retry);
    expect(html).toContain(strings.q_open_model_settings);
    expect(html).not.toContain(textMarkup(strings.q_stale_index));
    expect(html).not.toContain(textMarkup(strings.q_retrieval_failed));
    expect(html).not.toContain(strings.q_copy_answer);
    expect(html).not.toContain('data-testid="ask-local-fallback"');
    expect(html).not.toContain('class="ask-split"');
    expect(html).not.toContain('data-testid="ask-activity-coverage"');
  });

  it.each(["index_stale", "retrieval_failed"] as const)("maps persisted extractive fallback %s to localized recovery copy", (code) => {
    const copy = queryModule.askCopy(STRINGS.ko);
    const html = renderTurn({ q: "Synthetic legacy quotation", a: "SYN-QUOTATION", extractive: true,
      localFallback: code }, "ko");
    expect(html).toContain('data-testid="ask-local-fallback"');
    expect(html).toContain(textMarkup(code === "index_stale" ? copy.extractiveStale : copy.extractiveFailed));
    expect(html).toContain(STRINGS.ko.q_retry);
    expect(html).toContain("SYN-QUOTATION");
  });

  it.each(["index_stale", "retrieval_failed"] as const)("preserves the existing successful-answer notice for %s", (code) => {
    const html = renderTurn({ q: "Synthetic prior answer", a: "SYN-PRIOR-ANSWER",
      stale: code === "index_stale", retrievalFailed: code === "retrieval_failed" }, "en");
    expect(html).toContain("SYN-PRIOR-ANSWER");
    expect(html).toContain(textMarkup(code === "index_stale" ? STRINGS.en.q_stale_index : STRINGS.en.q_retrieval_failed));
    expect(html).toContain(STRINGS.en.q_open_model_settings);
  });
});

describe("Ask elapsed status", () => {
  it.each([1_000, 10_000_000])("keeps elapsed time on Ask remount when the wall clock changes to %s", wallTime => {
    const previous = useQueryStore.getState();
    const queryHook = useQueryStore;
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(wallTime);
    const monotonicClock = vi.spyOn(performance, "now").mockReturnValue(100_000);
    const hook = vi.spyOn(queryModule, "useQueryStore").mockImplementation(Object.assign(
      (selector: (state: typeof previous) => unknown) => selector(queryHook.getState()), queryHook,
    ) as typeof queryHook);
    Object.assign(hook, queryHook);
    try {
      useQueryStore.setState({ turns: [{ q: "Synthetic question", a: "" }],
        busy: true, startedAt: 34_000, stage: { kind: "thinking", stems: [] } });
      expect(renderToStaticMarkup(h(PageQuery, { t }))).toContain("1:06 경과");
      wallClock.mockReturnValue(wallTime + 3_600_000);
      monotonicClock.mockReturnValue(101_000);
      expect(renderToStaticMarkup(h(PageQuery, { t }))).toContain("1:07 경과");
    } finally {
      hook.mockRestore();
      wallClock.mockRestore();
      monotonicClock.mockRestore();
      useQueryStore.setState(previous);
    }
  });

  it.each([
    ["en", "Elapsed 1:06"],
    ["ko", "1:06 경과"],
    ["ja", "経過 1:06"],
  ] as const)("shows elapsed time beside the active status in %s while keeping Stop keyboard-accessible", (lang, elapsed) => {
    const previous = useQueryStore.getState();
    const queryHook = useQueryStore;
    const clock = vi.spyOn(performance, "now").mockReturnValue(100_000);
    const hook = vi.spyOn(queryModule, "useQueryStore").mockImplementation(Object.assign(
      (selector: (state: typeof previous) => unknown) => selector(queryHook.getState()), queryHook,
    ) as typeof queryHook);
    Object.assign(hook, queryHook);
    try {
      useQueryStore.setState({ turns: [{ q: "Previous question", a: "Previous answer" }, { q: "Synthetic question", a: "" }],
        busy: true, startedAt: 34_000, stage: { kind: "thinking", stems: [] } });
      const html = renderToStaticMarkup(h(PageQuery, { t: STRINGS[lang] }));
      expect(html).toContain(`<span role="timer" aria-live="off">${elapsed}</span>`);
      expect(html).toContain(`aria-label="${STRINGS[lang].q_answering}"`);
      const stopButton = html.match(new RegExp(`<button type="button" class="btn" aria-label="${STRINGS[lang].q_stop}"[^>]*>■</button>`))?.[0];
      expect(stopButton).toBeDefined();
      expect(stopButton).not.toMatch(/\s(?:disabled|aria-disabled="true"|tabindex="-1")/);
      expect(html.match(/role="timer"/g)).toHaveLength(1);
      expect(html).not.toMatch(/aria-label="[^"]*1:06/);

      useQueryStore.setState({ stage: { kind: "retrieving" } });
      const retrieving = renderToStaticMarkup(h(PageQuery, { t: STRINGS[lang] }));
      expect(retrieving).toContain(`aria-label="${STRINGS[lang].q_thinking}"`);
      expect(retrieving).toContain(elapsed);

      useQueryStore.setState({ busy: false, startedAt: null, turns: [{ q: "Synthetic question", a: "Synthetic answer" }], stage: null });
      const finished = renderToStaticMarkup(h(PageQuery, { t: STRINGS[lang] }));
      expect(finished).not.toContain('role="timer"');
      expect(finished).not.toContain(`aria-label="${STRINGS[lang].q_stop}"`);
    } finally {
      hook.mockRestore();
      clock.mockRestore();
      useQueryStore.setState(previous);
    }
  });

  it("clears the elapsed status immediately when a real pending Ask is stopped", async () => {
    const previousQuery = useQueryStore.getState();
    const previousVault = useVaultStore.getState();
    const queryHook = useQueryStore;
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const monotonicClock = vi.spyOn(performance, "now").mockReturnValue(34_000);
    let release!: (origin: AgentVaultSession) => void;
    const origin = vi.spyOn(ipc, "agentVaultSession").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const capture = vi.spyOn(ipc, "captureModelRole").mockResolvedValue(roleFixture("ask"));
    const history = vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
    const hook = vi.spyOn(queryModule, "useQueryStore").mockImplementation(Object.assign(
      (selector: (state: typeof previousQuery) => unknown) => selector(queryHook.getState()), queryHook,
    ) as typeof queryHook);
    Object.assign(hook, queryHook);
    try {
      useVaultStore.setState({ currentVault: { path: "/synthetic", name: "Synthetic vault" }, isOpeningVault: false });
      useQueryStore.setState({ busy: false, turns: [], stage: null, startedAt: null });
      const pending = useQueryStore.getState().ask("Synthetic attention question", "en", queryModule.askCopy(STRINGS.en));
      expect(useQueryStore.getState().startedAt).toBe(34_000);
      expect(renderToStaticMarkup(h(PageQuery, { t: STRINGS.en }))).toContain('role="timer"');
      useQueryStore.getState().stop();
      await expect(pending).resolves.toMatchObject({ stopped: true });
      expect(history).toHaveBeenCalledWith("/synthetic", expect.objectContaining({ at: 100_000, stopped: true }));
      const stopped = renderToStaticMarkup(h(PageQuery, { t: STRINGS.en }));
      expect(stopped).toContain(STRINGS.en.q_stopped);
      expect(stopped).not.toContain('role="timer"');
      expect(stopped).not.toContain(`aria-label="${STRINGS.en.q_stop}"`);
      expect(capture).not.toHaveBeenCalled();
      release({ vaultPath: "/synthetic", openingToken: "native-query" });
    } finally {
      useQueryStore.getState().stop();
      hook.mockRestore();
      origin.mockRestore();
      capture.mockRestore();
      history.mockRestore();
      wallClock.mockRestore();
      monotonicClock.mockRestore();
      useQueryStore.setState(previousQuery);
      useVaultStore.setState(previousVault);
    }
  });
});

describe("ExtractiveAnswer folds", () => {
  it("shows the first passage whole and folds the other four under one button", () => {
    const html = answer(FIVE);
    expect(html.match(/class="ask-sent[^"]*is-folded/g)).toHaveLength(4);
    expect(html).toMatch(/^<div class="ask-split">.*?<div class="ask-sent"/);
    expect(html).toContain('aria-expanded="false" aria-controls="ask-turn-0-body"');
    expect(html).toContain(t.q_more_passages.replace("{n}", "4"));
  });

  it("keeps a folded passage's words as they are and names its note above them", () => {
    const html = answer(FIVE);
    for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`passage number ${n} body`);
    for (const n of [2, 3, 4, 5]) expect(html).toContain(`class="ask-sent__note">note-${n}<`);
    // The first passage is read whole, its note named by the pill as before.
    expect(html).not.toContain('class="ask-sent__note">note-1<');
  });

  it("has nothing to fold with one passage", () => {
    const html = answer([hit(1, "only passage")]);
    expect(html).not.toContain("is-folded");
    expect(html).not.toContain('aria-controls="ask-turn-0-body"');
  });

  // A link under the fold took Tab and scrolled the box to it (overflow:
  // hidden scrolls from code), so focus sat on words nobody could see and the
  // fold stayed a mid-passage excerpt after focus left.
  it("unfolds a passage while focus is in it and never scrolls the fold", () => {
    const root = postcss.parse(readFileSync(resolve(__dirname, "../styles.css"), "utf8"));
    const decls = (selector: string): Record<string, string[]> => {
      const out: Record<string, string[]> = {};
      root.walkRules((rule) => {
        if (rule.selector !== selector) return;
        rule.walkDecls((d) => void (out[d.prop] ??= []).push(d.value));
      });
      return out;
    };
    expect(decls(".ask-sent.is-folded .myco-viewer").overflow?.at(-1)).toBe("clip");
    const focused = decls(".ask-sent.is-folded .myco-viewer:focus-within");
    expect(focused["max-height"]).toEqual(["none"]);
    expect(focused["mask-image"]).toEqual(["none"]);
  });
});

// UX S33: the rail lists the top three sources; the rest open in a side sheet.
describe("ExtractiveAnswer's source ladder", () => {
  const rows = (html: string): number => (html.match(/class="ask-lrow/g) ?? []).length;

  it("shows the top three and one button for all of them", () => {
    const html = answer(FIVE);
    expect(rows(html)).toBe(3);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain(t.q_ladder_all.replace("{n}", "5"));
  });

  it("needs no button when three or fewer were found", () => {
    const html = answer(FIVE.slice(0, 3));
    expect(rows(html)).toBe(3);
    expect(html).not.toContain('aria-haspopup="dialog"');
  });
});
