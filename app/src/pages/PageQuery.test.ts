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
import PageQuery, { ExtractiveAnswer, MissButton } from "./PageQuery";
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
