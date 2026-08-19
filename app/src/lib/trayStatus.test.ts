// The tray's frontend half: the title/menu payload builders and the
// debounced sender that keeps update_tray_status calls to state CHANGES
// (never per progress tick — at most one send per second).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraySender, buildTrayStatus, trayTitle } from "./trayStatus";
import type { TraySnapshot } from "./trayStatus";
import type { TrayStatusPayload } from "./ipc";
import { STRINGS } from "./i18n";

const idle: TraySnapshot = {
  askBusy: false,
  distillRunning: false,
  distillStep: null,
  reflectRunning: false,
  reflectUnseen: 0,
  reindexStage: "idle",
  reindexDone: 0,
  reindexTotal: 0,
  pendingLinks: 0,
  mcpRunning: true,
  inflow: null,
  sweepAt: null,
  autoImportMin: null,
};

describe("trayTitle", () => {
  it("is empty when nothing runs", () => {
    expect(trayTitle(idle)).toBeNull();
  });

  it("shows the reindex percent when indexing is the only runner", () => {
    expect(
      trayTitle({ ...idle, reindexStage: "indexing", reindexDone: 218, reindexTotal: 302 }),
    ).toBe("72%");
  });

  it("shows no number for a single non-reindex runner", () => {
    expect(trayTitle({ ...idle, distillRunning: true, distillStep: "run" })).toBeNull();
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
    expect(p.runningHeader).toBe("Now working on");
    expect(p.waitingHeader).toBe("Waiting");
    expect(p.title).toBe("2");
    expect(p.suggested).toBe("3 suggested links");
    expect(p.mcp).toBe("MCP server running");
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

  it("lists unseen reflect findings as a standing row, and nothing when seen", () => {
    expect(buildTrayStatus({ ...idle, reflectUnseen: 8 }, t).reflect).toBe(
      "8 reflect suggestions",
    );
    // Seen (or no findings) → empty string, which hides the row everywhere.
    expect(buildTrayStatus(idle, t).reflect).toBe("");
    // Standing state: it never inflates the tray title.
    expect(trayTitle({ ...idle, reflectUnseen: 8 })).toBeNull();
  });

  it("sends no running rows when idle", () => {
    const p = buildTrayStatus({ ...idle, mcpRunning: false }, t);
    expect(p.running).toEqual([]);
    expect(p.title).toBeNull();
    expect(p.mcp).toBe("MCP server off");
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
    runningHeader: "",
    waitingHeader: "",
    title,
    suggested: "",
    reflect: "",
    mcp: "",
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
