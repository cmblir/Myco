import { beforeEach, describe, expect, it, vi } from "vitest";

// Model calls and native role issuance are synthetic mocks. Each route is
// selected explicitly; connection or legacy display fields confer no consent.
const complete = vi.fn();
const captureModelRole = vi.fn();
vi.mock("../lib/chat", () => ({
  complete: (...a: unknown[]) => complete(...a),
}));

// The extractive path never calls complete(); it reads the link graph and,
// past MAX_SUGGESTIONS candidates, ranks them with the bundled embedder.
const buildLinkGraph = vi.fn();
const embedLocalTexts = vi.fn();
const agentVaultSession = vi.fn();
const reflectCreateMissingPage = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    agentVaultSession: (...a: unknown[]) => agentVaultSession(...a),
    captureModelRole: (...a: unknown[]) => captureModelRole(...a),
    reflectCreateMissingPage: (...a: unknown[]) => reflectCreateMissingPage(...a),
    buildLinkGraph: (...a: unknown[]) => buildLinkGraph(...a),
    embedLocalTexts: (...a: unknown[]) => embedLocalTexts(...a),
  },
}));

import {
  useReflectStore,
  parseSuggestions,
  extractiveReflect,
  isOwnNote,
  loadIgnored,
  reflectStatus,
  suggestionKey,
  suggestionPath,
} from "./reflectStore";
import type { ReflectSuggestion } from "./reflectStore";
import { STRINGS } from "../lib/i18n";
import { roleFixture } from "../lib/modelRoles.testSupport";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";

const currentOrigin = () => ({
  vaultPath: useVaultStore.getState().currentVault?.path ?? "",
  openingToken: `native-${useVaultStore.getState().vaultToken}`,
});

beforeEach(() => {
  captureModelRole.mockReset();
  agentVaultSession.mockReset();
  agentVaultSession.mockImplementation(async () => currentOrigin());
  reflectCreateMissingPage.mockReset();
  useVaultStore.setState({ refreshTree: vi.fn().mockResolvedValue(undefined), refreshLinkGraph: vi.fn().mockResolvedValue(undefined) });
});

describe("useReflectStore.runReflect", () => {
  beforeEach(() => {
    complete.mockReset();
    captureModelRole.mockReset();
    buildLinkGraph.mockReset();
    embedLocalTexts.mockReset();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, fileTree: [] });
    // Extractive findings are localized now — assert against the EN wording.
    useUIStore.setState({ lang: "en" });
    useReflectStore.setState({
      stage: "idle",
      mode: "llm",
      suggestions: [],
      report: null,
      startedAt: null,
      finishedAt: null,
      seen: true,
    });
  });

  it("builtin-local provider: extractive run — done stage, no complete() call", async () => {
    captureModelRole.mockImplementation(async (origin, role, usage) => roleFixture(role, "builtin-local", "", origin, usage));
    buildLinkGraph.mockResolvedValue({
      forward: { "/v/a.md": ["/v/b.md"], "/v/b.md": [] },
      backward: { "/v/b.md": ["/v/a.md"] },
      unresolved: { "/v/b.md": ["ghost"] },
      tags: {},
    });

    await useReflectStore.getState().runReflect();

    expect(complete).not.toHaveBeenCalled();
    const s = useReflectStore.getState();
    expect(s.stage).toBe("done");
    expect(s.mode).toBe("extractive");
    expect(s.suggestions).toEqual([
      { text: "a — no note links to it", kind: "orphan", page: "/v/a.md" },
      {
        text: "b — links to 'ghost', which doesn't exist yet",
        kind: "unresolved",
        link: "ghost",
        from: "/v/b.md",
      },
    ]);
    expect(s.found).toBe(2);
    expect(s.seen).toBe(false);
    // Few candidates: no need to pay for the embed-model load.
    expect(embedLocalTexts).not.toHaveBeenCalled();
  });

  it("connected provider that rejects: error stage with the provider's message, no double prefix", async () => {
    captureModelRole.mockImplementation(async (origin, role, usage) => roleFixture(role, "anthropic-cli", "sonnet", origin, usage));
    complete.mockRejectedValue(new Error("rate limited by provider"));

    await useReflectStore.getState().runReflect();

    const s = useReflectStore.getState();
    expect(s.stage).toBe("error");
    expect(s.report).toBe("rate limited by provider");
    expect(s.report).not.toMatch(/ERROR:/);
    expect(s.report).not.toMatch(/Error: Error:/);
  });

  it("connected provider that resolves: done stage with parsed suggestions, llm mode", async () => {
    captureModelRole.mockImplementation(async (origin, role, usage) => roleFixture(role, "anthropic-cli", "sonnet", origin, usage));
    complete.mockResolvedValue("- link orphan-a from index\n- revisit stale-b");

    await useReflectStore.getState().runReflect();

    const s = useReflectStore.getState();
    expect(s.stage).toBe("done");
    expect(s.mode).toBe("llm");
    // Model prose carries no kind: nothing to apply, so the panel offers no
    // action rather than parsing sentences back into structure.
    expect(s.suggestions).toEqual([
      { text: "link orphan-a from index" },
      { text: "revisit stale-b" },
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(buildLinkGraph).not.toHaveBeenCalled();
  });

  it("does nothing without an open vault", async () => {
    useVaultStore.setState({ currentVault: null });
    await useReflectStore.getState().runReflect();
    expect(captureModelRole).not.toHaveBeenCalled();
    expect(useReflectStore.getState().stage).toBe("idle");
  });
});

describe("Reflect vault ownership", () => {
  const gamma = { text: "g", kind: "unresolved" as const, link: "gamma", from: "/a/wiki/n.md" };
  const delta = { text: "d", kind: "unresolved" as const, link: "delta", from: "/a/wiki/n.md" };

  beforeEach(() => {
    complete.mockReset();
    captureModelRole.mockReset();
    captureModelRole.mockImplementation(async (origin, role, usage) => roleFixture(role, "anthropic-cli", "m", origin, usage));
    useVaultStore.setState({ currentVault: { path: "/a", name: "a" }, vaultToken: "a1", isOpeningVault: false });
    useReflectStore.getState().dismiss();
    useReflectStore.setState({ applying: false });
  });

  it.each(["switch", "reopen"])("discards a late result after a vault %s", async (kind) => {
    let release!: (value: string) => void;
    complete.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const pending = useReflectStore.getState().runReflect();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    useVaultStore.setState({
      currentVault: { path: kind === "switch" ? "/b" : "/a", name: "next" },
      vaultToken: "next", isOpeningVault: false,
    });
    release("- old vault finding");
    await pending;
    expect(useReflectStore.getState().stage).toBe("idle");
    expect(useReflectStore.getState().suggestions).toEqual([]);
    expect(useReflectStore.getState().report).toBeNull();
  });

  it("does not launch analysis after switching during model selection", async () => {
    captureModelRole.mockImplementationOnce(async (origin, role, usage) => {
      useVaultStore.setState({ currentVault: { path: "/b", name: "b" }, vaultToken: "b1" });
      return roleFixture(role, "anthropic-cli", "m", origin, usage);
    });
    await useReflectStore.getState().runReflect();
    expect(complete).not.toHaveBeenCalled();
    expect(useReflectStore.getState().stage).toBe("idle");
  });

  it("does not publish a dismissed run when it completes", async () => {
    let release!: (value: string) => void;
    complete.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const pending = useReflectStore.getState().runReflect();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    useReflectStore.getState().dismiss();
    release("- dismissed finding");
    await pending;
    expect(useReflectStore.getState().stage).toBe("idle");
    expect(useReflectStore.getState().suggestions).toEqual([]);
  });

  it.each(["switch", "reopen"])("refuses old rows after a vault %s", async (kind) => {
    complete.mockResolvedValueOnce("- finding");
    await useReflectStore.getState().runReflect();
    useReflectStore.setState({ suggestions: [gamma, delta] });
    reflectCreateMissingPage.mockResolvedValue("/b/wiki/gamma.md");
    useVaultStore.setState({
      currentVault: { path: kind === "switch" ? "/b" : "/a", name: "next" },
      vaultToken: "next",
    });
    const out = await useReflectStore.getState().createMissingPages([gamma]);
    expect(reflectCreateMissingPage).not.toHaveBeenCalled();
    expect(out.created).toBe(0);
  });

  it("stops a batch before its next write when the vault changes", async () => {
    complete.mockResolvedValueOnce("- finding");
    await useReflectStore.getState().runReflect();
    useReflectStore.setState({ suggestions: [gamma, delta] });
    reflectCreateMissingPage.mockImplementation(async () => {
      useVaultStore.setState({ currentVault: { path: "/b", name: "b" }, vaultToken: "b1" });
      return "/a/wiki/gamma.md";
    });
    const onProgress = vi.fn();
    await useReflectStore.getState().createMissingPages(undefined, onProgress);
    expect(reflectCreateMissingPage).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
    expect(useReflectStore.getState().suggestions).toEqual([]);
  });

  it("does not load the embedder for an extractive run whose graph returns after a switch", async () => {
    captureModelRole.mockImplementationOnce(async (origin, role, usage) => roleFixture(role, "builtin-local", "", origin, usage));
    embedLocalTexts.mockReset();
    buildLinkGraph.mockImplementationOnce(async () => {
      useVaultStore.setState({ currentVault: { path: "/b", name: "b" }, vaultToken: "b1" });
      return {
        forward: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`/a/wiki/n${i}.md`, []])),
        backward: {}, unresolved: {}, tags: {},
      };
    });
    await useReflectStore.getState().runReflect();
    expect(embedLocalTexts).not.toHaveBeenCalled();
    expect(useReflectStore.getState().stage).toBe("idle");
  });

  it("reports native origin failures before selecting a model", async () => {
    agentVaultSession.mockRejectedValueOnce(new Error("no vault is open"));
    await useReflectStore.getState().runReflect();
    expect(captureModelRole).not.toHaveBeenCalled();
    expect(useReflectStore.getState().stage).toBe("error");
    expect(useReflectStore.getState().report).toBe("no vault is open");
  });

  it("refuses a native root different from the captured frontend root", async () => {
    agentVaultSession.mockResolvedValueOnce({ vaultPath: "/b", openingToken: "native-b1" });
    await useReflectStore.getState().runReflect();
    expect(captureModelRole).not.toHaveBeenCalled();
    expect(useReflectStore.getState().stage).toBe("error");
    expect(useReflectStore.getState().report).toContain("active vault changed");
  });

  it("does not analyze if native origin capture finishes after reopening the same path", async () => {
    agentVaultSession.mockImplementationOnce(async () => {
      useVaultStore.setState({ vaultToken: "a2" });
      return { vaultPath: "/a", openingToken: "native-a2" };
    });
    await useReflectStore.getState().runReflect();
    expect(captureModelRole).not.toHaveBeenCalled();
    expect(useReflectStore.getState().stage).toBe("idle");
  });
});

describe("extractiveReflect", () => {
  beforeEach(() => {
    buildLinkGraph.mockReset();
    embedLocalTexts.mockReset();
    // Orphan candidacy now reads the vault's markdown tree — reset it so one
    // case's fixture files can't become another's orphan candidates.
    useVaultStore.setState({ fileTree: [] });
    useUIStore.setState({ lang: "en" });
  });

  it("skips orphan-exempt root pages", async () => {
    buildLinkGraph.mockResolvedValue({
      forward: { "/v/index.md": [], "/v/Home.md": [], "/v/note.md": [] },
      backward: {},
      unresolved: {},
      tags: {},
    });

    expect((await extractiveReflect("/v")).suggestions).toEqual([
      { text: "note — no note links to it", kind: "orphan", page: "/v/note.md" },
    ]);
  });

  // Regression for the real-vault reproduction (~/Documents/Memex, 180 walked
  // .md): the first version derived orphans from graph.forward's KEYS — which
  // Rust only writes for a page with a RESOLVED outgoing link — so link-less
  // pages were invisible, and it applied no knowledge filter, so
  // ingest-reports/ + five identical daily [[TASK_DONE]] ghosts crowded out the
  // one actionable finding. Fixture mirrors that shape: absolute paths, machine
  // folders present, one link-less knowledge page, one template placeholder.
  it("real-vault shape: reports link-less pages, drops machine files and placeholders", async () => {
    const V = "/Users/x/Documents/Memex";
    useVaultStore.setState({
      fileTree: [
        { kind: "file", name: "CHANGELOG.md", path: `${V}/CHANGELOG.md` },
        {
          kind: "directory",
          name: "wiki",
          path: `${V}/wiki`,
          children: [
            { kind: "file", name: "index.md", path: `${V}/wiki/index.md` },
            { kind: "file", name: "log.md", path: `${V}/wiki/log.md` },
            { kind: "file", name: "alpha.md", path: `${V}/wiki/alpha.md` },
            { kind: "file", name: "beta.md", path: `${V}/wiki/beta.md` },
            // No links in or out: the case forward's keys could never show.
            { kind: "file", name: "island.md", path: `${V}/wiki/island.md` },
          ],
        },
        {
          kind: "directory",
          name: "daily",
          path: `${V}/daily`,
          children: [
            { kind: "file", name: "2026-08-07.md", path: `${V}/daily/2026-08-07.md` },
            { kind: "file", name: "2026-08-09.md", path: `${V}/daily/2026-08-09.md` },
          ],
        },
        {
          kind: "directory",
          name: "ingest-reports",
          path: `${V}/ingest-reports`,
          children: [
            { kind: "file", name: "2026-05-18-goals.md", path: `${V}/ingest-reports/2026-05-18-goals.md` },
          ],
        },
        {
          kind: "directory",
          name: "raw",
          path: `${V}/raw`,
          children: [{ kind: "file", name: "paper.md", path: `${V}/raw/paper.md` }],
        },
      ],
    });
    buildLinkGraph.mockResolvedValue({
      forward: {
        [`${V}/wiki/index.md`]: [`${V}/wiki/alpha.md`],
        [`${V}/wiki/alpha.md`]: [`${V}/wiki/beta.md`],
      },
      backward: {
        [`${V}/wiki/alpha.md`]: [`${V}/wiki/index.md`],
        [`${V}/wiki/beta.md`]: [`${V}/wiki/alpha.md`],
      },
      unresolved: {
        [`${V}/wiki/alpha.md`]: ["gamma", "source-<slug>"],
        [`${V}/daily/2026-08-07.md`]: ["TASK_DONE"],
        [`${V}/daily/2026-08-09.md`]: ["TASK_DONE"],
        [`${V}/ingest-reports/2026-05-18-goals.md`]: ["..."],
      },
      tags: {},
    });

    const out = (await extractiveReflect(V)).suggestions;

    expect(out).toEqual([
      { text: "island — no note links to it", kind: "orphan", page: `${V}/wiki/island.md` },
      {
        text: "alpha — links to 'gamma', which doesn't exist yet",
        kind: "unresolved",
        link: "gamma",
        from: `${V}/wiki/alpha.md`,
      },
    ]);
    // A row names the note, never its path: the path lives in `page`/`from`,
    // where the open button and the row's title need it.
    for (const s of out) expect(s.text).not.toContain("/");
    // Under MAX_SUGGESTIONS after filtering: no embed-model load needed.
    expect(embedLocalTexts).not.toHaveBeenCalled();
  });

  it("past 8 candidates: embeds once and MMR-selects a deterministic top 8", async () => {
    // 10 orphans → 10 candidates. Fixture embeddings: near-identical pairs so
    // MMR must diversify, with i=0 closest to the centroid direction.
    const forward: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) forward[`/v/p${String(i).padStart(2, "0")}.md`] = [];
    buildLinkGraph.mockResolvedValue({ forward, backward: {}, unresolved: {}, tags: {} });
    const vectors = Array.from({ length: 10 }, (_, i) => [
      Math.cos(i * 0.3),
      Math.sin(i * 0.3),
    ]);
    embedLocalTexts.mockResolvedValue(vectors);

    const first = (await extractiveReflect("/v")).suggestions;
    const second = (await extractiveReflect("/v")).suggestions;

    expect(first).toHaveLength(8);
    expect(embedLocalTexts).toHaveBeenCalledTimes(2); // once per run
    expect(embedLocalTexts.mock.calls[0][0]).toHaveLength(10);
    // Deterministic: same inputs, same picks, same order.
    expect(second).toEqual(first);
    for (const s of first) expect(s.text).toMatch(/^p\d\d — no note links to it$/);
  });
});

describe("useReflectStore.createMissingPages", () => {
  const orphan = { text: "o", kind: "orphan" as const, page: "/v/o.md" };
  const gamma = { text: "g", kind: "unresolved" as const, link: "gamma", from: "/v/a.md" };
  const delta = { text: "d", kind: "unresolved" as const, link: "delta", from: "/v/a.md" };
  // The native creation seam receives the same immutable opening per row.

  beforeEach(() => {
    reflectCreateMissingPage.mockImplementation(async (_origin: unknown, name: string) => `/v/wiki/${name}.md`);
    useVaultStore.setState({
      currentVault: { path: "/v", name: "v" },
    });
    useReflectStore.setState({
      stage: "done", vault: "/v", vaultToken: useVaultStore.getState().vaultToken,
      origin: currentOrigin(),
      suggestions: [orphan, gamma, delta], applying: false,
    });
  });

  it("creates one page per unresolved suggestion, never for orphans", async () => {
    const progress: number[] = [];
    const out = await useReflectStore
      .getState()
      .createMissingPages(undefined, (done) => progress.push(done));

    expect(out).toEqual({ created: 2, failed: null });
    expect(reflectCreateMissingPage.mock.calls.map((c) => c[1])).toEqual(["gamma", "delta"]);
    expect(reflectCreateMissingPage.mock.calls.map((c) => c[0])).toEqual([currentOrigin(), currentOrigin()]);
    expect(progress).toEqual([1, 2]);
    // Applied findings leave the list; the orphan (nothing safe to write) stays.
    expect(useReflectStore.getState().suggestions).toEqual([orphan]);
  });

  it("stops at the first failure with an honest partial count, leaving the rest listed", async () => {
    reflectCreateMissingPage.mockImplementation(async (_origin: unknown, name: string) =>
      name === "gamma" ? "/v/wiki/gamma.md" : null,
    );

    const out = await useReflectStore.getState().createMissingPages();

    expect(out).toEqual({ created: 1, failed: "delta" });
    expect(reflectCreateMissingPage).toHaveBeenCalledTimes(2); // stopped, did not go on
    expect(useReflectStore.getState().suggestions).toEqual([orphan, delta]);
  });

  it("per-row apply creates only the row it was given", async () => {
    const out = await useReflectStore.getState().createMissingPages([delta]);

    expect(out).toEqual({ created: 1, failed: null });
    expect(reflectCreateMissingPage.mock.calls.map((c) => c[1])).toEqual(["delta"]);
    expect(useReflectStore.getState().suggestions).toEqual([orphan, gamma]);
  });
});

// The card's status: idle and running are said by the run button itself
// (a plain icon, then a spinner and "Running…"); done and failed get a line.
describe("reflectStatus", () => {
  const at = new Date(2026, 9, 2, 21, 42).getTime();

  it("idle and running carry no line — the button says which", () => {
    expect(reflectStatus({ stage: "idle", found: null, finishedAt: null, report: null }, STRINGS.en, "en")).toEqual({ tone: "idle" });
    expect(reflectStatus({ stage: "running", found: null, finishedAt: null, report: null }, STRINGS.en, "en")).toEqual({ tone: "running" });
  });

  it("done says done, the time and the run's count", () => {
    expect(reflectStatus({ stage: "done", found: 8, finishedAt: at, report: "x" }, STRINGS.ko, "ko")).toEqual({
      tone: "done",
      line: "완료 · 오후 9:42 · 제안 8개",
    });
    const time = new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(at);
    expect(reflectStatus({ stage: "done", found: 3, finishedAt: at, report: "x" }, STRINGS.en, "en")).toEqual({
      tone: "done",
      line: `Done · ${time} · 3 found`,
    });
  });

  it("failed says so plainly and keeps the provider's message", () => {
    expect(
      reflectStatus({ stage: "error", found: null, finishedAt: at, report: "rate limited" }, STRINGS.ko, "ko"),
    ).toEqual({ tone: "failed", line: STRINGS.ko.rf_failed, detail: "rate limited" });
  });
});

describe("parseSuggestions", () => {
  it("extracts bullet lines", () => {
    expect(parseSuggestions("- a\n- b\n* c\n1. d")).toEqual(["a", "b", "c", "d"]);
  });

  it("falls back to non-empty lines when nothing looks like a bullet", () => {
    expect(parseSuggestions("just prose\n\nmore prose")).toEqual([
      "just prose",
      "more prose",
    ]);
  });
});

// A run started mid bulk-apply would replace `suggestions` under the loop,
// stranding its progress UI and its own cleanup on a dead generation.
describe("run vs bulk-apply exclusion", () => {
  it("refuses to start a run while createMissingPages is in flight", async () => {
    const store = useReflectStore;
    store.setState({ applying: true, stage: "done" });
    const before = store.getState().stage;
    await store.getState().runReflect();
    expect(store.getState().stage).toBe(before); // never entered "running"
    store.setState({ applying: false });
  });

  it("clears the applying flag even when a creation fails", async () => {
    const store = useReflectStore;
    useVaultStore.setState({
      currentVault: { path: "/v", name: "v" },
    } as never);
    reflectCreateMissingPage.mockResolvedValue(null);
    store.setState({
      applying: false,
      stage: "done", vault: "/v", vaultToken: useVaultStore.getState().vaultToken,
      origin: currentOrigin(),
      suggestions: [{ text: "x", kind: "unresolved", link: "alpha", from: "/v/a.md" }],
    });
    const res = await store.getState().createMissingPages();
    expect(res.failed).toBe("alpha");
    expect(store.getState().applying).toBe(false);
  });
});

// An orphan stays an orphan and a dangling link stays dangling, so every run
// re-reports the same findings — that is what made the panel feel stuck.
describe("ignored findings", () => {
  it("drops ignored findings from the list and keeps them out of later runs", () => {
    const store = useReflectStore;
    const orphan = { text: "a", kind: "orphan" as const, page: "/v/wiki/a.md" };
    const link = { text: "b", kind: "unresolved" as const, link: "gamma", from: "/v/wiki/c.md" };
    store.setState({ vault: "/v", ignored: new Set(), suggestions: [orphan, link] });

    store.getState().ignore([orphan]);
    expect(store.getState().suggestions).toEqual([link]);
    expect([...store.getState().ignored]).toEqual([`/v\n${suggestionKey(orphan)}`]);
    store.setState({ ignored: new Set() });
  });

  it("keys orphans by page and links by target", () => {
    expect(suggestionKey({ text: "x", kind: "orphan", page: "/v/a.md" })).toBe(
      "orphan:/v/a.md",
    );
    expect(suggestionKey({ text: "x", kind: "unresolved", link: "beta", from: "/v/a.md" })).toBe(
      "link:beta",
    );
  });
});

// Owner, 2026-10-02: "분명 계속 완료라고 나오고 밑에 계속 남아있어" — a finished
// run whose list never went away. Spec 2026-10-02-home-notices-reflect #5-8.
describe("a Reflect that finishes", () => {
  // node has no localStorage; dismissals persist through it.
  class MemoryStorage {
    private m = new Map<string, string>();
    getItem(k: string): string | null {
      return this.m.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.m.set(k, v);
    }
    removeItem(k: string): void {
      this.m.delete(k);
    }
  }
  // One finding per vault: `${root}/wiki/a.md` links to [[gamma]], no page.
  const gammaGraph = async (root: string) => ({
    forward: {},
    backward: {},
    unresolved: { [`${root}/wiki/a.md`]: ["gamma"] },
    tags: {},
  });
  const emptyGraph = async () => ({ forward: {}, backward: {}, unresolved: {}, tags: {} });
  const links = () =>
    useReflectStore.getState().suggestions.map((s) => (s.kind === "unresolved" ? s.link : s.text));
  const run = () => useReflectStore.getState().runReflect();
  const inVault = (path: string) =>
    useVaultStore.setState({ currentVault: { path, name: path }, fileTree: [] });

  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    captureModelRole.mockReset();
    captureModelRole.mockImplementation(async (origin, role, usage) => roleFixture(role, "builtin-local", "", origin, usage));
    buildLinkGraph.mockReset();
    embedLocalTexts.mockReset();
    useUIStore.setState({ lang: "en" });
    inVault("/v");
    useReflectStore.setState({
      stage: "idle",
      vault: null,
      suggestions: [],
      found: null,
      ignored: new Set(),
      applying: false,
    });
  });

  it("a re-run clears the old list at once and replaces it, never appends", async () => {
    const old: ReflectSuggestion = { text: "old", kind: "orphan", page: "/v/old.md" };
    useReflectStore.setState({ stage: "done", suggestions: [old], found: 1 });
    let release!: (g: unknown) => void;
    buildLinkGraph.mockImplementation(() => new Promise((r) => (release = r)));

    const pending = run();
    await vi.waitFor(() => expect(useReflectStore.getState().stage).toBe("running"));
    expect(useReflectStore.getState().suggestions).toEqual([]);
    expect(useReflectStore.getState().found).toBeNull();

    await vi.waitFor(() => expect(buildLinkGraph).toHaveBeenCalledOnce());
    release(await gammaGraph("/v"));
    await pending;
    expect(useReflectStore.getState().stage).toBe("done");
    expect(links()).toEqual(["gamma"]);
    expect(useReflectStore.getState().found).toBe(1);
  });

  it("a failed run shows no list and says it failed", async () => {
    useReflectStore.setState({ stage: "done", suggestions: [{ text: "old" }], found: 1 });
    buildLinkGraph.mockRejectedValue(new Error("graph unavailable"));
    await run();
    const s = useReflectStore.getState();
    expect(s.stage).toBe("error");
    expect(s.suggestions).toEqual([]);
    expect(reflectStatus(s, STRINGS.en, "en")).toEqual({
      tone: "failed",
      line: STRINGS.en.rf_failed,
      detail: "graph unavailable",
    });
  });

  it("opening a finding takes its row out without remembering it", () => {
    const a: ReflectSuggestion = { text: "a", kind: "orphan", page: "/v/a.md" };
    const b: ReflectSuggestion = { text: "b", kind: "orphan", page: "/v/b.md" };
    useReflectStore.setState({ vault: "/v", stage: "done", suggestions: [a, b], found: 2 });
    useReflectStore.getState().drop([a]);
    expect(useReflectStore.getState().suggestions).toEqual([b]);
    expect(useReflectStore.getState().ignored.size).toBe(0);
    // The run's count stays the run's: the line keeps saying what it found.
    expect(useReflectStore.getState().found).toBe(2);
  });

  it("a dismissal holds in its vault across a reload, and only there", async () => {
    buildLinkGraph.mockImplementation(gammaGraph);
    await run();
    expect(links()).toEqual(["gamma"]);
    useReflectStore.getState().ignore(useReflectStore.getState().suggestions);
    expect(links()).toEqual([]);

    // A reload reads the dismissals back from storage.
    useReflectStore.setState({ ignored: loadIgnored() });
    await run();
    expect(links()).toEqual([]);
    expect(useReflectStore.getState().found).toBe(0);

    // Another vault with the same missing note still hears about it.
    inVault("/w");
    await run();
    expect(links()).toEqual(["gamma"]);
  });

  it("forgets a dismissal once its fact stops holding, so it is news when it holds again", async () => {
    buildLinkGraph.mockImplementation(gammaGraph);
    await run();
    useReflectStore.getState().ignore(useReflectStore.getState().suggestions);

    // The note got made: the fact is gone, and so is the dismissal.
    buildLinkGraph.mockImplementation(emptyGraph);
    await run();
    expect(loadIgnored().size).toBe(0);

    // The link dangles again later: that is a new finding.
    buildLinkGraph.mockImplementation(gammaGraph);
    await run();
    expect(links()).toEqual(["gamma"]);
  });

  it("still honours a dismissal saved before dismissals were per vault", async () => {
    localStorage.setItem("myco.reflect.ignored.v1", JSON.stringify(["link:gamma"]));
    useReflectStore.setState({ ignored: loadIgnored() });
    buildLinkGraph.mockImplementation(gammaGraph);
    await run();
    expect(links()).toEqual([]);
    inVault("/w");
    await run();
    expect(links()).toEqual([]);
  });

  it("skips dismissed findings before picking the top 8, so the rest get their turn", async () => {
    // Ten orphans; MMR would pick the same 8 every run, so dismissing those
    // 8 after the pick would leave an empty card over two live findings.
    const forward: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) forward[`/v/wiki/p${i}.md`] = [];
    buildLinkGraph.mockResolvedValue({ forward, backward: {}, unresolved: {}, tags: {} });
    embedLocalTexts.mockImplementation(async (texts: string[]) => texts.map((_, i) => [Math.cos(i), Math.sin(i)]));
    await run();
    expect(useReflectStore.getState().suggestions).toHaveLength(8);
    useReflectStore.getState().ignore(useReflectStore.getState().suggestions);

    embedLocalTexts.mockClear();
    await run();
    expect(useReflectStore.getState().suggestions).toHaveLength(2);
    expect(embedLocalTexts).not.toHaveBeenCalled();
  });
});

describe("only the owner's notes are judged", () => {
  const V = "/Users/x/vault";
  const file = (rel: string) => ({ kind: "file" as const, name: rel.split("/").pop() ?? rel, path: `${V}/${rel}` });

  it("isOwnNote: the folders myco keeps, its maps and welcome.md are not the owner's notes", () => {
    for (const rel of [
      "work/feedback/archive/2026-08-12-map-candidate.md",
      "audio/2026-09-01-memo.md",
      "welcome.md",
      "wiki/maps/attention.md",
      "templates/note.md",
      "CLAUDE.md",
      "sessions/s.md",
      "cards/c.md",
      "ingest-reports/r.md",
      "raw/paper.md",
      "_inbox/clip.md",
      "daily/2026-10-01.md",
    ])
      expect(isOwnNote(V, `${V}/${rel}`), rel).toBe(false);
    for (const rel of ["wiki/attention.md", "projects/plan.md", "note.md", "wiki/mapsish.md"])
      expect(isOwnNote(V, `${V}/${rel}`), rel).toBe(true);
  });

  it("orphan and missing-link findings skip them", async () => {
    useUIStore.setState({ lang: "en" });
    useVaultStore.setState({
      fileTree: [
        file("welcome.md"),
        file("wiki/maps/attention.md"),
        file("work/feedback/archive/old.md"),
        file("audio/memo.md"),
        file("wiki/real.md"),
      ],
    });
    buildLinkGraph.mockResolvedValue({
      forward: {},
      backward: {},
      unresolved: {
        [`${V}/welcome.md`]: ["ghost-a"],
        [`${V}/wiki/maps/attention.md`]: ["ghost-b"],
        [`${V}/work/feedback/x.md`]: ["ghost-c"],
        [`${V}/wiki/real.md`]: ["kept"],
      },
      tags: {},
    });
    const { suggestions } = await extractiveReflect(V);
    expect(suggestions.map((s) => (s.kind === "orphan" ? s.page : s.kind === "unresolved" ? s.link : s.text))).toEqual([
      `${V}/wiki/real.md`,
      "kept",
    ]);
  });
});

describe("plain words", () => {
  it("names the note in plain Korean, without its path", async () => {
    useUIStore.setState({ lang: "ko" });
    useVaultStore.setState({ fileTree: [] });
    buildLinkGraph.mockResolvedValue({
      forward: { "/v/wiki/attention.md": [] },
      backward: {},
      unresolved: { "/v/wiki/attention.md": ["flash-attention-3"] },
      tags: {},
    });
    const { suggestions } = await extractiveReflect("/v");
    expect(suggestions.map((s) => s.text)).toEqual([
      "attention — 아무 노트도 연결하지 않은 노트",
      "attention — 'flash-attention-3' 노트가 아직 없어요",
    ]);
    useUIStore.setState({ lang: "en" });
  });

  it("keeps the path for the row's title", () => {
    expect(suggestionPath({ text: "x", kind: "orphan", page: "/v/wiki/a.md" }, "/v")).toBe("wiki/a.md");
    expect(
      suggestionPath({ text: "x", kind: "unresolved", link: "gamma", from: "/v/wiki/a.md" }, "/v"),
    ).toBe("wiki/a.md → [[gamma]]");
    expect(suggestionPath({ text: "model prose" }, "/v")).toBeUndefined();
  });
});
