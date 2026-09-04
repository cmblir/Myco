// One ingest run at a time — the guard has to actually hold.
//
// startIngest reads `stage`, decides "not running", and only publishes
// "writing-raw" later. If anything awaits in between, a second caller reads the
// stale idle stage and starts a SECOND `claude` agent against the same vault:
// interleaved edits to the same wiki pages, doubled log.md entries, double token
// spend, and — because cancelIngest only knows the newest runId — an orphaned
// run the UI cannot stop.
//
// The window is not a timing fluke. `listen()` is async, so awaiting it always
// yields a microtask; two callers in the same tick both pass the guard however
// fast the IPC is. autoIngest.runInboxPass has two callers (the clip-saved
// event and the interval tick) that reach here through identical IPCs.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

vi.mock("./vaultStore", () => ({
  useVaultStore: {
    getState: () => ({
      currentVault: { path: "/v", name: "v" },
      refreshTree: vi.fn().mockResolvedValue(undefined),
      refreshLinkGraph: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("../lib/chat", () => ({ complete: vi.fn().mockResolvedValue("done") }));
// Shaped like the real `log` object ({ info/warn/error }), not a bare
// function — persistRunTranscript's failure path calls `log.warn(...)`.
vi.mock("../lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ipc } from "../lib/ipc";
import { useIngestStore, INGEST_PROMPT, applyStreamEvent } from "./ingestStore";

// Phase B, Task 6: INGEST_PROMPT's new 5th param weights linking/tagging
// toward the user's profile interests. Pure function, no ipc involved.
describe("INGEST_PROMPT profile interests grounding", () => {
  it("keeps the pre-Task-6 shape when profileInterests is omitted (default '')", () => {
    const prompt = INGEST_PROMPT("my-slug", "My Title");
    expect(prompt).not.toContain("User interests");
    expect(prompt).toContain(
      'New source has been added at `raw/my-slug.md` (title: "My Title")',
    );
  });

  it("adds one grounding line when profileInterests is non-empty", () => {
    const prompt = INGEST_PROMPT("my-slug", "My Title", [], [], "rust, vector search");
    expect(prompt).toContain(
      "User interests (weight linking/tagging toward these): rust, vector search",
    );
  });
});

describe("startIngest concurrency", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    listenMock.mockClear();
    useIngestStore.setState({ stage: "idle", runId: null });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "fileMtimes").mockResolvedValue([]);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      nodes: [],
      edges: [],
    } as never);
  });

  it("starts exactly one run when two callers race the same tick", async () => {
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    // Both callers reach startIngest before either has published a stage —
    // exactly what two runInboxPass triggers landing together look like.
    await Promise.all([
      useIngestStore.getState().startIngest("t", "b"),
      useIngestStore.getState().startIngest("t", "b"),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("holds even when listen() resolves instantly", async () => {
    // Not a slow-IPC problem: an await on an already-resolved promise still
    // yields. The guard must not straddle one.
    listenMock.mockImplementation(() => Promise.resolve(() => undefined));
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await Promise.all([
      useIngestStore.getState().startIngest("t", "b"),
      useIngestStore.getState().startIngest("t", "b"),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lets a second run start once the first has finished", async () => {
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");
    await useIngestStore.getState().startIngest("t", "b");

    expect(run).toHaveBeenCalledTimes(2);
  });
});

// Phase B, Task 6: startIngest's own wiring of the profile-interests
// grounding line (INGEST_PROMPT's pure-function behavior is covered above).
describe("startIngest profile interests wiring", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    listenMock.mockClear();
    useIngestStore.setState({ stage: "idle", runId: null });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "fileMtimes").mockResolvedValue([]);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      nodes: [],
      edges: [],
    } as never);
  });

  const PROFILE_MD =
    "## Role\nBackend engineer\n\n## Goals\n- Ship it\n\n" +
    "## Interests\n- rust\n- vector search\n\n## Working style\nConcise\n";

  it("passes profile interests into the ingest prompt when the toggle is on and a profile exists", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({
      profile_injection: true,
    } as never);
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: PROFILE_MD } as never);
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");

    const [, prompt] = run.mock.calls[0];
    expect(prompt).toContain(
      "User interests (weight linking/tagging toward these): rust, vector search",
    );
  });

  it("omits the interests line when there is no profile", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({
      profile_injection: true,
    } as never);
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("not found"));
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");

    const [, prompt] = run.mock.calls[0];
    expect(prompt).not.toContain("User interests");
  });

  it("omits the interests line when the toggle is off, even with a profile on disk", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({
      profile_injection: false,
    } as never);
    const readFile = vi
      .spyOn(ipc, "readFile")
      .mockResolvedValue({ raw: PROFILE_MD } as never);
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");

    const [, prompt] = run.mock.calls[0];
    expect(prompt).not.toContain("User interests");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("fails closed (omits the interests line) when the distill config can't be read", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockRejectedValue(new Error("io error"));
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: PROFILE_MD } as never);
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");

    const [, prompt] = run.mock.calls[0];
    expect(prompt).not.toContain("User interests");
  });
});

// Phase 1f: the deterministic validator replaced the old mtime-only gate.
// These cover the new branch — validator errors block, warnings don't.
describe("ingest validation gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    listenMock.mockClear();
    useIngestStore.setState({ stage: "idle", runId: null });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      nodes: [],
      edges: [],
    } as never);
    vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({
      stdout: "ok",
      stderr: "",
      status: 0,
    } as never);
  });

  it("blocks on validator errors instead of reaching done", async () => {
    // wikiBefore snapshot (empty) then afterMtimes showing one wiki page
    // changed, so the run has something to validate.
    vi.spyOn(ipc, "fileMtimes")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([["/v/wiki/foo.md", 1]]);
    const validate = vi.spyOn(ipc, "validateIngest").mockResolvedValue({
      errors: [
        { page: "wiki/foo.md", kind: "dangling_citation", detail: "no raw/bar.md" },
      ],
      warnings: [],
    });

    await useIngestStore.getState().startIngest("t", "b");

    // Vault-relative, not the absolute fileMtimes path — validate_pages (Rust)
    // requires `rel.starts_with("wiki/")` and silently skips anything else.
    expect(validate).toHaveBeenCalledWith("/v", ["wiki/foo.md"]);
    expect(useIngestStore.getState().stage).toBe("error");
    expect(useIngestStore.getState().log).toContain("wiki/foo.md");
    expect(useIngestStore.getState().log).toContain("no raw/bar.md");
  });

  it("reaches done and surfaces warnings when the validator only warns", async () => {
    vi.spyOn(ipc, "fileMtimes")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([["/v/wiki/foo.md", 1]]);
    vi.spyOn(ipc, "validateIngest").mockResolvedValue({
      errors: [],
      warnings: [
        { page: "wiki/foo.md", kind: "unresolved_wikilink", detail: "[[bar]] not found" },
      ],
    });

    await useIngestStore.getState().startIngest("t", "b");

    expect(useIngestStore.getState().stage).toBe("done");
    expect(useIngestStore.getState().log).toContain("[[bar]] not found");
  });

  it("fails as before (no-changes) when no wiki page changed, without calling the validator", async () => {
    vi.spyOn(ipc, "fileMtimes").mockResolvedValue([]);
    const validate = vi.spyOn(ipc, "validateIngest");

    await useIngestStore.getState().startIngest("t", "b");

    expect(validate).not.toHaveBeenCalled();
    expect(useIngestStore.getState().stage).toBe("error");
  });
});

// Feed-render perf: the panel re-rendered 500 rows per stream event because
// every event handed subscribers new array identities. Rows are now keyed by
// `seq`, and `touched` must keep its identity when nothing about it changed.
describe("applyStreamEvent identity + seq", () => {
  const ev = (
    kind: "text" | "tool",
    over: { tool?: string; detail?: string; text?: string } = {},
  ) => ({
    run_id: "r",
    kind,
    tool: over.tool ?? null,
    detail: over.detail ?? null,
    text: over.text ?? null,
  });

  beforeEach(() => {
    // Write events schedule the debounced live rescan through `window`, which
    // the node test env does not provide.
    vi.stubGlobal("window", {
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    useIngestStore.setState({ events: [], touched: [], readCount: 0, writeCount: 0 });
  });

  it("gives every event a strictly increasing seq", () => {
    applyStreamEvent(ev("text", { text: "a" }));
    applyStreamEvent(ev("text", { text: "b" }));
    const { events } = useIngestStore.getState();
    expect(events).toHaveLength(2);
    expect(events[1].seq).toBeGreaterThan(events[0].seq);
  });

  it("keeps the touched array identity when the same page is read twice", () => {
    applyStreamEvent(ev("tool", { tool: "Read", detail: "wiki/a.md" }));
    const first = useIngestStore.getState().touched;
    applyStreamEvent(ev("tool", { tool: "Read", detail: "wiki/a.md" }));
    expect(useIngestStore.getState().touched).toBe(first);
    expect(useIngestStore.getState().readCount).toBe(2);
  });

  it("replaces it only when a page flips read → written", () => {
    applyStreamEvent(ev("tool", { tool: "Read", detail: "wiki/a.md" }));
    const first = useIngestStore.getState().touched;
    applyStreamEvent(ev("tool", { tool: "Write", detail: "wiki/a.md" }));
    const second = useIngestStore.getState().touched;
    expect(second).not.toBe(first);
    expect(second[0].write).toBe(true);
  });

  it("keeps identity when a plain text event arrives", () => {
    applyStreamEvent(ev("tool", { tool: "Read", detail: "wiki/a.md" }));
    const first = useIngestStore.getState().touched;
    applyStreamEvent(ev("text", { text: "thinking" }));
    expect(useIngestStore.getState().touched).toBe(first);
  });
});
