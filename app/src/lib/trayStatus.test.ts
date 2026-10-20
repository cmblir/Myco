// The tray's frontend half: the title/menu payload builders and the
// debounced sender that keeps update_tray_status calls to state CHANGES
// (never per progress tick — at most one send per second).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
import {
  TraySender,
  applyTrayAction,
  buildTrayStatus,
  bumpedKeys,
  failedKinds,
  initTrayIntegration,
  pickNowCard,
  trayTitle,
} from "./trayStatus";
import type { TraySnapshot } from "./trayStatus";
import { EMPTY_AGENDA } from "./notchAgenda";
import { pairKey } from "./linkSuggestions";
import { ipc } from "./ipc";
import * as autoIngest from "./autoIngest";
import type {
  FileContent,
  HarvestCandidates,
  InflowStats,
  TrayStatusPayload,
  VaultMeta,
} from "./ipc";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import { useHarvestStore } from "../stores/harvestStore";
import { useDistillStore } from "../stores/distillStore";
import { useQueryStore } from "../stores/queryStore";
import { STRINGS } from "./i18n";

const idle: TraySnapshot = {
  askBusy: false,
  distillRunning: false,
  distillStep: null,
  reflectRunning: false,
  reflectFindings: 0,
  reindexStage: "idle",
  reindexDone: 0,
  reindexTotal: 0,
  pendingLinks: 0,
  mapProposals: [],
  applyingProposals: 0,
  mapsNeedWriter: false,
  mcpRunning: true,
  inflow: null,
  sweepAt: null,
  autoImportMin: null,
  dueToday: 0,
  overdue: 0,
  agenda: EMPTY_AGENDA,
  harvest: { total: 0, done: 0, phase: null },
  progress: null,
  failed: [],
};

describe("tray read probe concurrency", () => {
  let cleanup: (() => void) | undefined;
  const inflow: InflowStats = { sessionsToday: 1, inboxToday: 0, inboxBySource: {}, mcpCallsToday: 0, mcpTopTool: null, hourlyFiles: [], hourlyMcp: [] };
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    useVaultStore.setState({ currentVault: { path: "/synthetic-probes", name: "Synthetic" }, vaultToken: "probe-open-1", isOpeningVault: false, revision: null });
    useQueryStore.setState({ busy: false });
    vi.spyOn(ipc, "updateTrayStatus").mockResolvedValue(null);
    vi.spyOn(ipc, "mcpInfo").mockResolvedValue({ running: false } as Awaited<ReturnType<typeof ipc.mcpInfo>>);
    vi.spyOn(ipc, "scanTasks").mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(ipc, "inflowStats").mockImplementation(() => new Promise(() => undefined));
  });
  afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

  it("starts one held inflow IPC read despite repeated production vault subscriptions", () => {
    cleanup = initTrayIntegration();
    for (let revision = 1; revision <= 20; revision++) useVaultStore.setState({ revision });
    expect(ipc.inflowStats).toHaveBeenCalledTimes(1);
  });

  it("does not start another held due read when the two-minute send throttle expires", async () => {
    cleanup = initTrayIntegration();
    useVaultStore.setState({ revision: 1 });
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(120_000);
    useQueryStore.setState({ busy: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(ipc.scanTasks).toHaveBeenCalledTimes(1);
  });

  it("allows a new token immediately and ignores the old response without unlocking the new read", async () => {
    let oldAnswer!: (value: InflowStats) => void;
    vi.mocked(ipc.inflowStats).mockImplementationOnce(() => new Promise((resolve) => { oldAnswer = resolve; }));
    cleanup = initTrayIntegration();
    useVaultStore.setState({ revision: 1 });
    useVaultStore.setState({ vaultToken: "probe-open-2" });
    expect(ipc.inflowStats).toHaveBeenCalledTimes(2);
    expect(ipc.scanTasks).toHaveBeenCalledTimes(2);
    oldAnswer(inflow);
    await vi.advanceTimersByTimeAsync(300);
    useVaultStore.setState({ revision: 1 });
    expect(ipc.inflowStats).toHaveBeenCalledTimes(2);
    const sent = vi.mocked(ipc.updateTrayStatus).mock.calls.at(-1)?.[0];
    expect(sent?.panel?.actionScope?.vaultToken).toBe("probe-open-2");
    expect(sent?.inflow).toBeNull();
  });

  it("allows another vault to start immediately while the first vault read is pending", () => {
    cleanup = initTrayIntegration();
    useVaultStore.setState({ currentVault: { path: "/synthetic-other", name: "Other" }, vaultToken: "other-open" });
    expect(vi.mocked(ipc.inflowStats).mock.calls.map(([path]) => path)).toEqual(["/synthetic-probes", "/synthetic-other"]);
  });

  it("ignores the old due response and keeps the newer token's pending read exclusive", async () => {
    let oldAnswer!: (tasks: Awaited<ReturnType<typeof ipc.scanTasks>>) => void;
    vi.mocked(ipc.scanTasks).mockImplementationOnce(() => new Promise((resolve) => { oldAnswer = resolve; }));
    cleanup = initTrayIntegration();
    useVaultStore.setState({ revision: 1 });
    useVaultStore.setState({ vaultToken: "probe-open-2" });
    oldAnswer([{ page: "daily/synthetic.md", stem: "synthetic", line: 1, text: "Synthetic old task @2026-10-01", done: false, status: "todo" }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.mocked(ipc.updateTrayStatus).mock.calls.at(-1)?.[0].panel?.counts.overdue).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    useQueryStore.setState({ busy: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(ipc.scanTasks).toHaveBeenCalledTimes(2);
  });

  it("releases a failed inflow read so a subsequent store event can retry", async () => {
    vi.mocked(ipc.inflowStats).mockRejectedValueOnce(new Error("Synthetic slow filesystem failure")).mockResolvedValueOnce(inflow);
    cleanup = initTrayIntegration();
    await vi.advanceTimersByTimeAsync(0);
    useVaultStore.setState({ revision: 1 });
    await vi.advanceTimersByTimeAsync(300);
    expect(ipc.inflowStats).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ipc.updateTrayStatus).mock.calls.at(-1)?.[0].inflow?.sessionsCount).toContain("1");
  });

  it("retains the two-minute throttle after completed reads and releases both owners for the next interval", async () => {
    vi.mocked(ipc.inflowStats).mockResolvedValue(inflow);
    vi.mocked(ipc.scanTasks).mockResolvedValue([]);
    cleanup = initTrayIntegration();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(119_000);
    useQueryStore.setState({ busy: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(ipc.inflowStats).toHaveBeenCalledTimes(1);
    expect(ipc.scanTasks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    useQueryStore.setState({ busy: false });
    await vi.advanceTimersByTimeAsync(300);
    expect(ipc.inflowStats).toHaveBeenCalledTimes(2);
    expect(ipc.scanTasks).toHaveBeenCalledTimes(2);
  });
});

describe("trayTitle", () => {
  it("is empty when nothing runs", () => {
    expect(trayTitle(idle)).toBeNull();
  });

  it("shows the reindex percent when indexing is the only runner", () => {
    expect(
      trayTitle({
        ...idle,
        reindexStage: "indexing",
        reindexDone: 218,
        reindexTotal: 302,
      }),
    ).toBe("72%");
  });

  it("shows no number for a single non-reindex runner", () => {
    expect(
      trayTitle({ ...idle, distillRunning: true, distillStep: "run" }),
    ).toBeNull();
  });

  it("shows the running count for two or more", () => {
    expect(
      trayTitle({
        ...idle,
        askBusy: true,
        reindexStage: "indexing",
        reindexDone: 1,
        reindexTotal: 10,
      }),
    ).toBe("2");
  });
});

describe("buildTrayStatus", () => {
  const t = STRINGS.en;

  it("mirrors the popover rows: running info, standing counts, actions", () => {
    const p = buildTrayStatus(
      {
        ...idle,
        distillRunning: true,
        distillStep: "digest",
        reindexStage: "indexing",
        reindexDone: 218,
        reindexTotal: 302,
        pendingLinks: 3,
      },
      t,
    );
    expect(p.running).toEqual([
      { kind: "distill", text: "Distilling… — the session digest" },
      { kind: "index", text: "Indexing… 218/302" },
    ]);
    expect(p.title).toBe("2");
    expect(p.suggested).toBe("3 suggested links");
    expect(p.distill).toBe(t.set_distill_run_now);
    expect(p.open).toBe("Open myco");
    expect(p.quit).toBe("Quit myco");
  });

  it("gives a running reflect its own row and counts it in the title", () => {
    const p = buildTrayStatus({ ...idle, reflectRunning: true }, t);
    expect(p.running).toEqual([{ kind: "reflect", text: "Reflect running…" }]);
    // One runner → no number (like a lone distill), two → the count.
    expect(p.title).toBeNull();
    expect(
      trayTitle({ ...idle, reflectRunning: true, distillRunning: true }),
    ).toBe("2");
  });

  it("reports a harvest batch and a link batch as running, with their steps", () => {
    // The owner's "모두 수락 (58)" and a 20-session harvest: work the notch
    // narrates, and myco roams for (docs/specs/2026-10-02-mascot-roam.md).
    const ko = STRINGS.ko;
    const p = buildTrayStatus(
      {
        ...idle,
        harvest: { total: 20, done: 11, phase: "ingesting" },
        progress: { key: "links", label: ko.ls_linking, done: 3, total: 58 },
      },
      ko,
    );
    expect(p.running).toEqual([
      { kind: "ingest", text: "수확 중 11/20" },
      { kind: "links", text: "링크 중 3/58" },
    ]);
    expect(p.title).toBe("2");
    const copying = buildTrayStatus(
      { ...idle, harvest: { total: 20, done: 0, phase: "copying" } },
      t,
    );
    expect(copying.running).toEqual([
      { kind: "ingest", text: "Harvesting… · Copying sources…" },
    ]);
    expect(copying.title).toBeNull();
  });

  it("names the jobs whose last run failed, so the notch can say so", () => {
    expect(buildTrayStatus({ ...idle, failed: ["ingest", "links"] }, t).failed).toEqual([
      "ingest",
      "links",
    ]);
    expect(buildTrayStatus(idle, t).failed).toEqual([]);
  });

  it("reads a failed run off each job's own store", () => {
    const ok = {
      harvest: null,
      distill: null,
      reflect: "done",
      reindex: "done",
      linksFailed: false,
    } as const;
    expect(failedKinds(ok)).toEqual([]);
    expect(
      failedKinds({
        harvest: "error",
        distill: "error",
        reflect: "error",
        reindex: "error",
        linksFailed: true,
      }),
    ).toEqual(["ingest", "distill", "reflect", "index", "links"]);
  });

  it("keeps reflect findings out of the tray title (a standing state)", () => {
    expect(trayTitle({ ...idle, reflectFindings: 8 })).toBeNull();
  });

  it("caps the map-proposal rows and keeps the builtin-local caveat", () => {
    const maps = Array.from({ length: 7 }, (_, i) => ({
      path: `work/feedback/map-${i}.md`,
      action: "draft-map" as const,
      status: "pending" as const,
      created: "2026-08-12",
      title: `Map candidate: c${i}`,
      raw: "",
      files: [],
      cluster: `c${i}`,
      members: ["wiki/a.md", "wiki/b.md"],
    }));
    const p = buildTrayStatus(
      { ...idle, mapProposals: maps, mapsNeedWriter: true },
      t,
    );
    expect(p.proposals).toHaveLength(5);
    expect(p.proposals?.[0]).toEqual({
      path: "work/feedback/map-0.md",
      label: "c0",
      sub: "Draft topic map · 2 notes",
    });
    expect(p.proposalApprove).toBe("Approve");
    expect(p.proposalReject).toBe("Dismiss");
    expect(p.proposalNote).toBe(t.pf_map_needs_writer);
    // A provider that CAN draft leaves the caveat off.
    expect(
      buildTrayStatus({ ...idle, mapProposals: maps }, t).proposalNote,
    ).toBe("");
  });

  it("sends no running rows when idle", () => {
    const p = buildTrayStatus({ ...idle, mcpRunning: false }, t);
    expect(p.running).toEqual([]);
    expect(p.title).toBeNull();
    // idle snapshot carries inflow: null (no probe yet) — block absent.
    expect(p.inflow).toBeNull();
  });

  it("bakes translated inflow lines + hourly buckets into the payload", () => {
    const hourlyFiles = Array<number>(24).fill(0);
    hourlyFiles[9] = 2;
    const hourlyMcp = Array<number>(24).fill(0);
    hourlyMcp[14] = 7;
    const p = buildTrayStatus(
      {
        ...idle,
        inflow: {
          sessionsToday: 2,
          inboxToday: 3,
          inboxBySource: { clipper: 2, unknown: 1 },
          mcpCallsToday: 7,
          mcpTopTool: "search",
          hourlyFiles,
          hourlyMcp,
        },
      },
      t,
    );
    expect(p.inflow).toEqual({
      header: "Today's inflow",
      sessions: "Sessions swept",
      sessionsSub: "",
      sessionsCount: "+2",
      mcp: "MCP tool calls",
      mcpSub: "top: search · since app launch",
      mcpCount: "7",
      inbox: "_inbox arrivals",
      inboxSub: "clipper 2 · unknown 1",
      inboxCount: "+3",
      inboxView: "View →",
      sparkCaption: "Last 24h · purple = sessions/inbox · blue = MCP calls",
      summary: "Today: sessions +2 · MCP 7 · inbox +3",
      hourlyFiles,
      hourlyMcp,
    });
  });

  it("keeps the inflow block (zeros shown) when nothing arrived today", () => {
    const zeros = Array<number>(24).fill(0);
    const p = buildTrayStatus(
      {
        ...idle,
        inflow: {
          sessionsToday: 0,
          inboxToday: 0,
          inboxBySource: {},
          mcpCallsToday: 0,
          mcpTopTool: null,
          hourlyFiles: zeros,
          hourlyMcp: zeros,
        },
      },
      t,
    );
    // Zero stats still render the block — only a missing probe hides it.
    expect(p.inflow).not.toBeNull();
    expect(p.inflow?.sessionsCount).toBe("+0");
  });
});

describe("TraySender", () => {
  let sent: TrayStatusPayload[];
  let sender: TraySender;

  const payload = (title: string | null): TrayStatusPayload => ({
    running: [],
    title,
    suggested: "",
    ask: "a",
    distill: "d",
    open: "o",
    quit: "q",
  });

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    sender = new TraySender((p) => sent.push(p));
  });

  afterEach(() => {
    sender.dispose();
    vi.useRealTimers();
  });

  it("coalesces a burst of pushes into one trailing send of the latest", () => {
    sender.push(payload("1%"));
    sender.push(payload("2%"));
    sender.push(payload("3%"));
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(sent).toEqual([payload("3%")]);
  });

  it("throttles progress ticks to at most one send per second", () => {
    sender.push(payload("10%"));
    vi.advanceTimersByTime(300); // first send at t=300
    // A tick every 100ms for 2 seconds.
    for (let i = 0; i < 20; i++) {
      sender.push(payload(`${11 + i}%`));
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(1000); // drain the trailing send
    expect(sent.length).toBeLessThanOrEqual(4); // ~1/s over ~3s, not 21
    expect(sent[sent.length - 1]).toEqual(payload("30%")); // latest always lands
  });

  it("drops identical payloads instead of re-sending", () => {
    sender.push(payload("50%"));
    vi.advanceTimersByTime(300);
    sender.push(payload("50%"));
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([payload("50%")]);
  });

  it("sends nothing after dispose", () => {
    sender.push(payload("1%"));
    sender.dispose();
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([]);
  });
});

describe("applying proposals", () => {
  const t = STRINGS.en;

  it("counts as a runner in the title and narrates as a running row", () => {
    // Two runners (ask + applying) → the icon-side title shows the count.
    expect(trayTitle({ ...idle, askBusy: true, applyingProposals: 1 })).toBe("2");
    const p = buildTrayStatus({ ...idle, applyingProposals: 1 }, t);
    expect(p.running.map((r) => r.kind)).toEqual(["distill"]);
    expect(p.running[0].text).toBe("Applying proposal…");
  });

  it("more than one apply shows the multiplier", () => {
    const p = buildTrayStatus({ ...idle, applyingProposals: 3 }, t);
    expect(p.running[0].text).toBe("Applying proposal… ×3");
  });
});

describe("tray v3 panel", () => {
  const t = STRINGS.en;

  it("subtitle: distilling beats waiting beats clear", () => {
    expect(
      buildTrayStatus(
        { ...idle, distillRunning: true, distillStep: "maps", overdue: 2 },
        t,
      ).greeting,
    ).toBe("Distilling · the map drafts");
    expect(
      buildTrayStatus(
        {
          ...idle,
          overdue: 1,
          mapProposals: [
            {
              path: "work/feedback/map-a.md",
              action: "draft-map",
              status: "pending",
              created: "2026-08-12",
              title: "Map candidate: a",
              raw: "",
              files: [],
              cluster: "a",
              members: [],
            },
          ],
        },
        t,
      ).greeting,
    ).toBe("2 waiting for you");
    expect(buildTrayStatus(idle, t).greeting).toBe("Nothing waiting");
  });

  it("carries raw tile counts + labels for the panel", () => {
    const p = buildTrayStatus(
      {
        ...idle,
        pendingLinks: 4,
        reflectFindings: 8,
        overdue: 1,
        inflow: {
          sessionsToday: 2,
          inboxToday: 3,
          inboxBySource: {},
          mcpCallsToday: 7,
          mcpTopTool: null,
          hourlyFiles: [],
          hourlyMcp: [],
        },
      },
      t,
    );
    expect(p.panel?.counts).toEqual({
      links: 4,
      reflect: 8,
      overdue: 1,
      dueToday: 0,
      files: 5,
      mcpCalls: 7,
    });
    expect(p.panel?.mcpRunning).toBe(true);
    expect(p.panel?.labels.tasksOverdue).toBe("1 overdue");
    expect(p.panel?.labels.toastApproved).toBe("{name} approved");
  });

  it("now-card priority: proposal > overdue task > links > nothing", () => {
    expect(pickNowCard({ proposals: 1, overdue: 3, links: 9 })).toBe(
      "proposal",
    );
    expect(pickNowCard({ proposals: 0, overdue: 3, links: 9 })).toBe(
      "overdue",
    );
    expect(pickNowCard({ proposals: 0, overdue: 0, links: 9 })).toBe("links");
    expect(pickNowCard({ proposals: 0, overdue: 0, links: 0 })).toBeNull();
  });

  it("bump detection: only keys that grew, nothing on the first push", () => {
    expect(bumpedKeys(null, { a: 1, b: 2 })).toEqual([]);
    expect(bumpedKeys({ a: 1, b: 2, c: 5 }, { a: 2, b: 2, c: 4 })).toEqual([
      "a",
    ]);
  });
});

describe("applyTrayAction", () => {
  beforeEach(() => {
    useUIStore.setState({ route: "query", focusTarget: null, feedbackTab: "proposals" });
  });

  it("a plain route action just routes", () => {
    applyTrayAction("overview");
    expect(useUIStore.getState().route).toBe("overview");
    expect(useUIStore.getState().focusTarget).toBeNull();
  });

  it("links / reflect route to Overview AND point at their section", () => {
    applyTrayAction("links");
    expect(useUIStore.getState().route).toBe("overview");
    expect(useUIStore.getState().focusTarget).toEqual({ id: "links", nonce: 1 });
    // Already on Overview: the route call is a no-op, the nonce is the only
    // thing that makes the tile's second click do anything.
    applyTrayAction("reflect");
    expect(useUIStore.getState().route).toBe("overview");
    expect(useUIStore.getState().focusTarget).toEqual({ id: "reflect", nonce: 1 });
  });

  it("quarantine is a tab, not a route", () => {
    applyTrayAction("quarantine");
    expect(useUIStore.getState().route).toBe("feedback");
    expect(useUIStore.getState().feedbackTab).toBe("quarantine");
  });

  it("an unknown action changes nothing", () => {
    applyTrayAction("nope");
    expect(useUIStore.getState().route).toBe("query");
    expect(useUIStore.getState().focusTarget).toBeNull();
  });
});

// The three decisions the notch offers. It cannot write — no vault in that
// webview — so it sends these strings and the writes happen HERE, through the
// same functions Overview's own cards call.
describe("the notch's agenda decisions", () => {
  const A = "/v/wiki/otp.md";
  const B = "/v/wiki/magic-links.md";
  const KEY = pairKey(A, B);
  const scope = { vaultPath: "/v", vaultToken: "synthetic-open" };
  const origin = { vaultPath: "/v", openingToken: "synthetic-native-opening" };
  const revision = "a".repeat(64);
  const copied = (rels: string[]) => ({
    copied: rels.length,
    inbox_rels: rels,
    skipped: [],
    inbox_sources: rels.map((rel) => ({
      source_rel: rel.replace("_inbox/", "sessions/"),
      inbox_rel: rel,
      source_revision: revision,
    })),
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    useVaultStore.setState({
      currentVault: { path: "/v", name: "v" } as VaultMeta,
      vaultToken: scope.vaultToken,
      isOpeningVault: false,
      adjacency: {
        forward: {},
        backward: {},
        unresolved: {},
        tags: {},
      },
    });
    useLinkSuggestStore.setState({
      sem: [{ source: A, target: B, score: 0.9 }],
      dismissed: new Set<string>(),
      busy: false,
    });
    useHarvestStore.setState({
      data: null,
      loading: false,
      scannedPath: null,
      scannedToken: null,
      run: { total: 0, done: 0, phase: null },
    });
  });

  it.each([
    undefined,
    { vaultPath: "/old-vault", vaultToken: scope.vaultToken },
    { vaultPath: "/v", vaultToken: "previous-open" },
  ])(
    "rejects an unscoped, cross-vault or reopened-vault proposal before invoking its writer (%s)",
    async (requestScope) => {
      const apply = vi
        .spyOn(useDistillStore.getState(), "apply")
        .mockResolvedValue("synthetic.md");
      await expect(
        applyTrayAction(
          "proposal-approve:work/feedback/shared.md",
          requestScope,
        ),
      ).rejects.toThrow("Vault action scope is no longer active");
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it("rejects a matching scoped action during a vault transition", async () => {
    useVaultStore.setState({ isOpeningVault: true });
    const dismiss = vi
      .spyOn(useDistillStore.getState(), "dismiss")
      .mockResolvedValue(true);
    await expect(
      applyTrayAction("proposal-reject:work/feedback/shared.md", scope),
    ).rejects.toThrow("Vault action scope is no longer active");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it.each([
    "distill",
    "links-accept-all",
    "links-dismiss-all",
    `links-accept:${KEY}`,
    `links-dismiss:${KEY}`,
    "harvest-run",
  ])("fails closed for a legacy unscoped mutation: %s", async (action) => {
    const write = vi.spyOn(ipc, "writeFileIfUnchanged");
    const dismiss = vi.spyOn(useLinkSuggestStore.getState(), "dismiss");
    await expect(applyTrayAction(action)).rejects.toThrow(
      "Vault action scope is no longer active",
    );
    expect(write).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("dismissing a link marks exactly that pair", async () => {
    await applyTrayAction(`links-dismiss:${KEY}`, scope);
    expect([...useLinkSuggestStore.getState().dismissed]).toEqual([KEY]);
  });

  it("does not acknowledge a proposal apply that returns failure or needs a writer", async () => {
    vi.spyOn(useDistillStore.getState(), "apply").mockResolvedValue(null);
    await expect(
      applyTrayAction("proposal-approve:work/feedback/synthetic.md", scope),
    ).rejects.toThrow("Proposal action did not complete");
  });

  it("acknowledges a successfully applied proposal", async () => {
    const apply = vi
      .spyOn(useDistillStore.getState(), "apply")
      .mockResolvedValue("wiki/synthetic.md");
    await expect(
      applyTrayAction("proposal-approve:work/feedback/synthetic.md", scope),
    ).resolves.toBeUndefined();
    expect(apply).toHaveBeenCalledWith("work/feedback/synthetic.md");
  });

  it("does not acknowledge a failed proposal dismissal", async () => {
    vi.spyOn(useDistillStore.getState(), "dismiss").mockResolvedValue(false);
    await expect(
      applyTrayAction("proposal-reject:work/feedback/synthetic.md", scope),
    ).rejects.toThrow("Proposal dismissal did not complete");
  });

  it("acknowledges a successfully dismissed proposal", async () => {
    const dismiss = vi
      .spyOn(useDistillStore.getState(), "dismiss")
      .mockResolvedValue(true);
    await expect(
      applyTrayAction("proposal-reject:work/feedback/synthetic.md", scope),
    ).resolves.toBeUndefined();
    expect(dismiss).toHaveBeenCalledWith("work/feedback/synthetic.md");
  });

  it("accepting a link appends the wikilink through acceptSuggestion", async () => {
    const read = vi
      .spyOn(ipc, "readFile")
      .mockResolvedValue({ path: A, raw: "# otp\n" } as FileContent);
    const write = vi.spyOn(ipc, "writeFileIfUnchanged").mockResolvedValue(null);
    vi.spyOn(ipc, "buildLinkGraph").mockRejectedValue(new Error("no backend"));
    await applyTrayAction(`links-accept:${KEY}`, scope);
    expect(write).toHaveBeenCalled();
    // The source page is what gets the link, under ## Related — the one write
    // path, not a second one bolted onto the notch.
    expect(read).toHaveBeenCalledWith(A);
    expect(write.mock.calls[0][0]).toBe(A);
    expect(String(write.mock.calls[0][1])).toContain(
      "[[wiki/magic-links|magic-links]]",
    );
    // Accepted pairs leave the queue, exactly as they do from the card.
    expect(useLinkSuggestStore.getState().dismissed.has(KEY)).toBe(true);
  });

  it("a stale link key writes nothing", async () => {
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    await expect(
      applyTrayAction("links-accept:/v/gone.md|/v/nope.md", scope),
    ).rejects.toThrow("Link action did not complete");
    expect(write).not.toHaveBeenCalled();
  });

  it("harvesting runs every listed candidate and reports on the run slice", async () => {
    useHarvestStore.setState({
      scannedPath: "/v",
      scannedToken: scope.vaultToken,
      data: {
        items: [
          { path: "/v/sessions/a.md", rel: "sessions/a.md" },
          { path: "/v/sessions/b.md", rel: "sessions/b.md" },
        ],
      } as HarvestCandidates,
    });
    const run = vi
      .spyOn(ipc, "harvestRun")
      .mockResolvedValue(copied(["_inbox/a.md", "_inbox/b.md"]));
    const pass = vi
      .spyOn(autoIngest, "runInboxPass")
      .mockImplementation(async (_root, opts) => ({
        ingested: true,
        sourcePath: opts?.sourcePath,
        sourceRevision: opts?.sourceRevision,
        origin: opts?.origin,
        harvestCompleted: true,
        pendingChunks: 0,
        held: 0,
        refused: 0,
        unsupported: 0,
      }));
    const reload = vi
      .spyOn(ipc, "harvestCandidates")
      .mockResolvedValue({ items: [] } as unknown as HarvestCandidates);
    const action = applyTrayAction("harvest-run", scope);
    // startRun is synchronous: the Topbar has to show the run immediately, not
    // after harvest_run answers.
    expect(useHarvestStore.getState().run.phase).toBe("copying");
    await action;
    expect(useHarvestStore.getState().outcome).toBe("done");
    expect(run).toHaveBeenCalledWith(
      ["/v/sessions/a.md", "/v/sessions/b.md"],
      "/v",
      origin,
    );
    expect(ipc.agentVaultSession).toHaveBeenCalledTimes(1);
    for (const [, options] of pass.mock.calls)
      expect(options).toMatchObject({
        usage: "foreground",
        sourceRevision: revision,
        origin,
      });
    expect(pass.mock.calls.map((call) => call[1]?.sourcePath)).toEqual([
      "/v/_inbox/a.md",
      "/v/_inbox/b.md",
    ]);
    expect(useHarvestStore.getState().run.phase).toBeNull();
    // The queue is refetched, so the row leaves the notch too.
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("harvesting with an empty queue does not acknowledge completion", async () => {
    const run = vi.spyOn(ipc, "harvestRun");
    await expect(applyTrayAction("harvest-run", scope)).rejects.toThrow(
      "Harvest did not complete",
    );
    expect(run).not.toHaveBeenCalled();
    expect(useHarvestStore.getState().run.phase).toBeNull();
  });

  it("does not relabel another vault's cached harvest candidates", async () => {
    useHarvestStore.setState({
      scannedPath: "/old-vault",
      scannedToken: scope.vaultToken,
      data: {
        items: [{ path: "/old-vault/sessions/a.md" }],
      } as HarvestCandidates,
    });
    const run = vi.spyOn(ipc, "harvestRun");
    await expect(applyTrayAction("harvest-run", scope)).rejects.toThrow(
      "Harvest did not complete",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("an old harvest completion cannot ingest, refetch or end a reopened vault's newer run", async () => {
    useHarvestStore.setState({
      scannedPath: "/v",
      scannedToken: scope.vaultToken,
      data: { items: [{ path: "/v/sessions/a.md" }] } as HarvestCandidates,
    });
    let answer!: (result: Awaited<ReturnType<typeof ipc.harvestRun>>) => void;
    vi.spyOn(ipc, "harvestRun").mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const pass = vi.spyOn(autoIngest, "runInboxPass");
    const reload = vi.spyOn(ipc, "harvestCandidates");
    const action = applyTrayAction("harvest-run", scope);
    await vi.waitFor(() => expect(ipc.harvestRun).toHaveBeenCalledTimes(1));
    useVaultStore.setState({ vaultToken: "reopened-vault" });
    useHarvestStore.setState({
      run: { total: 7, done: 2, phase: "ingesting" },
    });
    answer(copied(["_inbox/a.md"]));
    await expect(action).rejects.toThrow("Harvest did not complete");
    expect(pass).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(useHarvestStore.getState().run).toEqual({
      total: 7,
      done: 2,
      phase: "ingesting",
    });
  });

  it("a second harvest cannot start over a live one", async () => {
    useHarvestStore.setState({
      data: { items: [{ path: "/v/sessions/a.md" }] } as HarvestCandidates,
      run: { total: 1, done: 0, phase: "ingesting" },
    });
    const run = vi.spyOn(ipc, "harvestRun");
    await expect(applyTrayAction("harvest-run", scope)).rejects.toThrow(
      "Harvest did not complete",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("does not acknowledge a native archive whose harvest completion remains false", async () => {
    useHarvestStore.setState({
      data: { items: [{ path: "/v/sessions/a.md" }] } as HarvestCandidates,
      scannedPath: "/v",
      scannedToken: scope.vaultToken,
    });
    vi.spyOn(ipc, "harvestRun").mockResolvedValue(copied(["_inbox/a.md"]));
    vi.spyOn(autoIngest, "runInboxPass").mockResolvedValue({
      ingested: true,
      harvestCompleted: false,
      pendingChunks: 0,
      sourcePath: "/v/_inbox/a.md",
      sourceRevision: revision,
      origin,
      held: 0,
      unsupported: 0,
      refused: 0,
    });
    vi.spyOn(ipc, "harvestCandidates").mockResolvedValue({
      items: [],
    } as unknown as HarvestCandidates);
    await expect(applyTrayAction("harvest-run", scope)).rejects.toThrow(
      "Harvest did not complete",
    );
    expect(useHarvestStore.getState().outcome).toBe("error");
    expect(useHarvestStore.getState().run.done).toBe(0);
  });

  it("does not copy after origin capture resolves for a same-path reopened vault", async () => {
    useHarvestStore.setState({
      data: { items: [{ path: "/v/sessions/a.md" }] } as HarvestCandidates,
      scannedPath: "/v",
      scannedToken: scope.vaultToken,
    });
    let answer!: (value: typeof origin) => void;
    vi.spyOn(ipc, "agentVaultSession").mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const copy = vi.spyOn(ipc, "harvestRun");
    const action = applyTrayAction("harvest-run", scope);
    useVaultStore.setState({ vaultToken: "synthetic-reopened" });
    useHarvestStore.setState({
      run: { total: 3, done: 1, phase: "ingesting" },
    });
    answer(origin);
    await expect(action).rejects.toThrow("Harvest did not complete");
    expect(copy).not.toHaveBeenCalled();
    expect(useHarvestStore.getState().run).toEqual({
      total: 3,
      done: 1,
      phase: "ingesting",
    });
  });

  it("rejects the notch acknowledgement when copies have not been processed", async () => {
    useHarvestStore.setState({
      data: { items: [{ path: "/v/sessions/a.md" }] } as HarvestCandidates,
      scannedPath: "/v",
      scannedToken: scope.vaultToken,
    });
    vi.spyOn(ipc, "harvestRun").mockResolvedValue(copied(["_inbox/a.md"]));
    vi.spyOn(autoIngest, "runInboxPass").mockResolvedValue({
      ingested: false,
      held: 1,
      refused: 0,
      unsupported: 0,
      sourcePath: "/v/_inbox/a.md",
      sourceRevision: revision,
      origin,
      pendingChunks: 5,
    });
    vi.spyOn(ipc, "harvestCandidates").mockResolvedValue({
      items: [],
    } as unknown as HarvestCandidates);
    await expect(applyTrayAction("harvest-run", scope)).rejects.toThrow(
      "Harvest did not complete",
    );
    expect(useHarvestStore.getState().outcome).toBe("error");
    expect(useHarvestStore.getState().run.done).toBe(0);
  });
});
