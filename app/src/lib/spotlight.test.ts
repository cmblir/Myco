import { describe, expect, it, vi } from "vitest";

// spotlight.ts pulls in the persisted uiStore, whose storage must exist first.
vi.hoisted(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
});
// The bridge's half of the event bus, through the real @tauri-apps/api/event
// (a vi.mock of it races the bridge's concurrent import()s): the IPC shim
// keeps each subscribed handler.
type Handler = (e: { payload: unknown }) => void;
// ...and each emitted event, in order.
const { handlers, emitted } = vi.hoisted(() => {
  const m = new Map<string, Handler>();
  const emitted: { event: string; payload: unknown }[] = [];
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {
      transformCallback: (cb: Handler) => cb,
      invoke: (cmd: string, args: { event: string; handler: Handler; payload: unknown }) => {
        if (cmd === "plugin:event|listen") m.set(args.event, args.handler);
        if (cmd === "plugin:event|emit") emitted.push({ event: args.event, payload: args.payload });
        return Promise.resolve(0);
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
  });
  return { handlers: m, emitted };
});
import {
  initSpotlightBridge,
  SPOTLIGHT_ANSWER_EVENT,
  SPOTLIGHT_ASK_EVENT,
  SPOTLIGHT_OPEN_ASK_EVENT,
  SPOTLIGHT_OPEN_DAILY_EVENT,
  SPOTLIGHT_OPEN_INBOX_EVENT,
  spotlightAnswerOf,
} from "./spotlight";
import { takeReaderIntent } from "./askLoop";
import { ipc, type MycoSettings } from "./ipc";
import { roleFixture, selectedRolesFixture } from "./modelRoles.testSupport";
import { STRINGS } from "./i18n";
import { askCopy, useQueryStore } from "../stores/queryStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

describe("initSpotlightBridge", () => {
  // ■ on the Ask page while a Spotlight question runs (UX S36): the
  // Spotlight hears "stopped" at once, and the Ask page's next question is
  // never sent back as the Spotlight question's answer.
  it("answers a Spotlight question stopped with ■ at once, as stopped", async () => {
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useUIStore.setState({ askScope: "wiki", lang: "en" });
    useQueryStore.getState().clear();
    vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      query_provider: "ollama",
      query_model: "llama3",
      model_roles: selectedRolesFixture({ ask: { providerId: "ollama", modelId: "llama3" } }),
    } as MycoSettings);
    const origin = { vaultPath: "/v", openingToken: "native-spotlight" };
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
    vi.spyOn(ipc, "captureModelRole").mockResolvedValue(roleFixture("ask", "ollama", "llama3", origin));
    vi.spyOn(ipc, "getDistillConfig").mockRejectedValue(new Error("no config"));
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 0, model: "" });
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    const answers: ((content: string) => void)[] = [];
    vi.spyOn(ipc, "chatComplete").mockImplementation(
      () =>
        new Promise((r) =>
          answers.push((content) => r({ provider_id: "ollama", model: "llama3", content, usage: null })),
        ),
    );
    const replies = () => emitted.filter((e) => e.event === SPOTLIGHT_ANSWER_EVENT).map((e) => e.payload);
    emitted.length = 0;
    const stop = initSpotlightBridge();
    await vi.waitFor(() => expect(handlers.has(SPOTLIGHT_ASK_EVENT)).toBe(true));
    handlers.get(SPOTLIGHT_ASK_EVENT)?.({ payload: "what is a transformer" });
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    useQueryStore.getState().stop();
    await vi.waitFor(() =>
      expect(replies()).toEqual([
        expect.objectContaining({ question: "what is a transformer", answer: "", stopped: true }),
      ]),
    );
    // The Ask page asks on; the stopped call comes back late.
    const next = useQueryStore.getState().ask("what is RAG", "en", askCopy(STRINGS.en));
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]("RAG is retrieval-augmented generation");
    await next;
    answers[0]("late transformer answer");
    await new Promise((r) => setTimeout(r, 0));
    expect(replies()).toHaveLength(1);
    stop();
    vi.restoreAllMocks();
  });

  it("the spotlight's \"Open in Ask\" shows the Ask page", async () => {
    useUIStore.setState({ route: "overview" });
    const stop = initSpotlightBridge();
    await vi.waitFor(() => expect(handlers.has(SPOTLIGHT_OPEN_ASK_EVENT)).toBe(true));
    handlers.get(SPOTLIGHT_OPEN_ASK_EVENT)?.({ payload: null });
    expect(useUIStore.getState().route).toBe("query");
    stop();
  });

  it("the receipt's Open shows the daily note the spotlight wrote, and nothing else", async () => {
    // The path comes from another webview: only a daily note of this vault
    // opens, never an arbitrary file.
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, fileTree: [] });
    useUIStore.setState({ route: "overview" });
    const stop = initSpotlightBridge();
    await vi.waitFor(() => expect(handlers.has(SPOTLIGHT_OPEN_DAILY_EVENT)).toBe(true));
    const open = handlers.get(SPOTLIGHT_OPEN_DAILY_EVENT);
    open?.({ payload: { rel: "../etc/passwd", line: "- 09:05 x" } });
    open?.({ payload: { rel: "wiki/attention.md", line: "- 09:05 x" } });
    open?.({ payload: "daily/2026-10-02.md" });
    await new Promise((r) => setTimeout(r, 0));
    expect(useUIStore.getState().route).toBe("overview");
    expect(takeReaderIntent("/v/wiki/attention.md")).toBeNull();
    open?.({ payload: { rel: "daily/2026-10-02.md", line: "- 09:05 질문: 주말 등산 코스 추천" } });
    await vi.waitFor(() => expect(useUIStore.getState().route).toBe("page:/v/daily/2026-10-02.md"));
    // On the written line, as Home's Open: a busy day's last line is
    // off the first screen.
    expect(takeReaderIntent("/v/daily/2026-10-02.md")).toEqual({
      kind: "show",
      section: null,
      quote: "- 09:05 질문: 주말 등산 코스 추천",
    });
    stop();
  });

  it("the voice receipt's Open shows the _inbox note it named, and nothing else", async () => {
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, fileTree: [] });
    useUIStore.setState({ route: "overview" });
    const stop = initSpotlightBridge();
    await vi.waitFor(() => expect(handlers.has(SPOTLIGHT_OPEN_INBOX_EVENT)).toBe(true));
    const open = handlers.get(SPOTLIGHT_OPEN_INBOX_EVENT);
    for (const bad of ["_inbox/../wiki/a.md", "wiki/a.md", "_inbox/sub/a.md", "_inbox/a.txt", 7, null])
      open?.({ payload: bad });
    await new Promise((r) => setTimeout(r, 0));
    expect(useUIStore.getState().route).toBe("overview");
    open?.({ payload: "_inbox/voice-2026-10-03-0912.md" });
    await vi.waitFor(() =>
      expect(useUIStore.getState().route).toBe("page:/v/_inbox/voice-2026-10-03-0912.md"),
    );
    stop();
  });
});

describe("spotlightAnswerOf (the bridge payload)", () => {
  it("an abstained turn says so and claims no quote from the notes", () => {
    const p = spotlightAnswerOf("zzqq", {
      q: "zzqq",
      a: "Nothing relevant found in the wiki index. Try rephrasing, or run “Reindex now”.",
      extractive: true,
      extractiveEmpty: true,
      abstained: true,
      range: { start: "2026-09-21", end: "2026-09-27" },
    });
    expect(p.abstained).toBe(true);
    expect(p.extractive).toBeFalsy();
    expect(p.range).toEqual({ start: "2026-09-21", end: "2026-09-27" });
  });

  it("a stale index's advice is not labelled as quoted either", () => {
    const p = spotlightAnswerOf("q", { q: "q", a: "reindex", extractive: true, extractiveEmpty: true });
    expect(p.extractive).toBeFalsy();
    expect(p.abstained).toBeFalsy();
  });

  it("quoted passages stay extractive", () => {
    const p = spotlightAnswerOf("attention", { q: "attention", a: "> quote", extractive: true, extractiveEmpty: false });
    expect(p).toEqual(expect.objectContaining({ question: "attention", answer: "> quote", extractive: true }));
  });

  it("carries each quoted note's similarity for the details, best chunk per note", () => {
    const hit = (page: string, similarity: number | null) => ({
      page,
      stem: page.replace(/^wiki\/|\.md$/g, ""),
      section: 0,
      text: "t",
      score: 0.1,
      similarity,
    });
    const p = spotlightAnswerOf("q", {
      q: "q",
      a: "**[[a]]**",
      extractive: true,
      extractiveEmpty: false,
      hits: [hit("wiki/a.md", 0.61), hit("wiki/b.md", null), hit("wiki/a.md", 0.71)],
    });
    expect(p.relevance).toEqual([
      { stem: "a", similarity: 0.71 },
      { stem: "b", similarity: null },
    ]);
    expect(spotlightAnswerOf("q", { q: "q", a: "x" }).relevance).toBeUndefined();
  });

  it("a stopped turn says it was stopped", () => {
    const p = spotlightAnswerOf("q", { q: "q", a: "", stopped: true });
    expect(p).toEqual(expect.objectContaining({ question: "q", answer: "", stopped: true }));
  });

  it("no turn (the ask returned early) is an empty answer", () => {
    expect(spotlightAnswerOf("q", undefined)).toEqual(expect.objectContaining({ question: "q", answer: "" }));
  });
});
