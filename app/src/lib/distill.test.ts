import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn().mockResolvedValue(false), requestPermission: vi.fn().mockResolvedValue("denied"), sendNotification: vi.fn() }));

const draftMap = vi.fn();
vi.mock("./maps", () => ({ draftMap: (...a: unknown[]) => draftMap(...a) }));

// Controllable digest outcome — the cold-tier prune trigger keys off it.
const runSessionDigest = vi.fn();
vi.mock("./sessionDigest", () => ({
  runSessionDigest: (...a: unknown[]) => runSessionDigest(...a),
}));

// Controllable full-tier outcome — the shared llm_ingest_budget test below
// needs a fixed "ingested" count without wiring up fullTierIngest's own ipc
// calls (fullTierItems/readFile/claudeRun); every other test here only
// needs its "self-skips on builtin-local" default (ingested: 0), same as
// the real function's own no-provider path.
// Controllable weekly-rollup outcome — the second compression layer's own
// cold-tier prune trigger keys off it, the same way the digest's does. Mocked
// rather than exercised: rollup.ts imports from ./sessionDigest, which
// is already mocked here.
const runWeeklyRollup = vi.fn();
const runMonthlyRollup = vi.fn();
vi.mock("./rollup", () => ({
  runWeeklyRollup: (...a: unknown[]) => runWeeklyRollup(...a),
  runMonthlyRollup: (...a: unknown[]) => runMonthlyRollup(...a),
}));

const runFullTierIngest = vi.fn();
vi.mock("./fullTierIngest", () => ({
  runFullTierIngest: (...a: unknown[]) => runFullTierIngest(...a),
}));

import {
  archiveBucketKey,
  backlogTrend,
  formatRunOutcome,
  lastResurfaceOutcome,
  lastWorkflowReceipt,
  WorkflowRunError,
  lastRunLabel,
  lastStopPoint,
  llmStepsWaiting,
  pendingShrank,
  requestDistillStop,
  runDistillGuarded,
} from "./distill";
import { ipc } from "./ipc";
import { tryLock, unlock } from "./vaultLock";
import { STRINGS } from "./i18n";
import { useVaultStore } from "../stores/vaultStore";
import { useReindexStore } from "../stores/reindexStore";
import { useResurfaceStore } from "../stores/resurfaceStore";
import { useDistillRunStore } from "../stores/distillRunStore";
import { WorkflowOperationError } from "./workflowOutcome";
import type { BucketUsage, DistillConfig, RunReport } from "./distill";
import type { EmbeddingsStatus, FileNode, MycoSettings } from "./ipc";
import { roleFixture, selectedRolesFixture } from "./modelRoles.testSupport";
import { BUILTIN_CHAT_MODEL } from "./providers";

let organizationChoice = { providerId: "builtin-local", modelId: "extractive-ingest" };
function mockOrganizationAdmission(): void {
  organizationChoice = { providerId: "builtin-local", modelId: "extractive-ingest" };
  vi.spyOn(ipc, "getSettings").mockResolvedValue({ model_roles: selectedRolesFixture({ organization: organizationChoice }) } as MycoSettings);
  vi.spyOn(ipc, "agentVaultSession").mockImplementation(async () => ({
    vaultPath: vi.mocked(ipc.distillRun).mock.calls.at(-1)![0], openingToken: "synthetic-organization-opening",
  }));
  vi.spyOn(ipc, "captureModelRole").mockImplementation(async (origin, role, usage) => {
    expect(role).toBe("organization");
    return roleFixture(role, organizationChoice.providerId, organizationChoice.modelId, origin, usage);
  });
}

describe("archiveBucketKey", () => {
  it("stays unique when a loose bucket and its own zip coexist (partial restore)", () => {
    // Real shape `archive_usage` can return after a restore fails partway:
    // the bucket exists as both a loose directory and its untouched zip.
    const loose: BucketUsage = { tree: "daily", bucket: "2026-W02", files: 1, bytes: 100, packed: false };
    const packed: BucketUsage = { tree: "daily", bucket: "2026-W02", files: 7, bytes: 41_000, packed: true };
    expect(archiveBucketKey(loose)).not.toBe(archiveBucketKey(packed));
  });
});

describe("backlogTrend", () => {
  it("flat with fewer than two samples", () => {
    expect(backlogTrend([])).toBe("flat");
    expect(backlogTrend([5])).toBe("flat");
  });

  it("shrinking when the newest sample is below the oldest", () => {
    expect(backlogTrend([9, 7, 4])).toBe("shrinking");
  });

  it("growing when the newest sample is above the oldest", () => {
    expect(backlogTrend([2, 5, 9])).toBe("growing");
  });

  it("flat when the oldest and newest samples are equal", () => {
    expect(backlogTrend([5, 9, 5])).toBe("flat");
  });
});

describe("formatRunOutcome", () => {
  const report = (over: Partial<RunReport> = {}): RunReport => ({
    id: "r1",
    scan: {
      scored: 0,
      quarantined: 0,
      rejected: 0,
      summaries: 0,
      full: 0,
      skipped_immature: 0,
      gate_wiki_pages: null,
    },
    trashed: 0,
    proposals: 0,
    backlog_after: 0,
    ...over,
  });

  const en = STRINGS.en;

  it("says 'nothing to process' for a run that moved nothing", () => {
    expect(formatRunOutcome(report(), 0, 0, en)).toBe(
      "Distill finished — nothing to process",
    );
  });

  it("reports unfinished evidence instead of claiming there was nothing to process", () => {
    expect(formatRunOutcome(report(), 0, 0, en, 0, 2)).toBe(
      en.set_distill_evidence_pending.replace("{n}", "2"),
    );
  });

  it("appends the monthly clause only when a month actually rolled up", () => {
    // A month rolls up roughly once a month; the other runs must not carry a
    // permanent "0 monthly rollups".
    expect(formatRunOutcome(report({ proposals: 1 }), 0, 0, en)).not.toContain("monthly");
    expect(formatRunOutcome(report({ proposals: 1 }), 0, 0, en, 1)).toBe(
      "Distill finished — 0 days digested · 0 weeks rolled up · 1 proposals · 1 monthly rollups",
    );
    // A run whose ONLY work was the monthly rollup still reports it rather
    // than claiming nothing happened.
    expect(formatRunOutcome(report(), 0, 0, en, 2)).toContain("2 monthly rollups");
  });

  // Owner decision 2026-10-03 (B1): no run moves raw/, so the line carries
  // no "archived" count.
  it("substitutes digested/rolled-up/proposals counts, with no archived count", () => {
    expect(formatRunOutcome(report({ proposals: 2 }), 3, 1, en)).toBe(
      "Distill finished — 3 days digested · 1 weeks rolled up · 2 proposals",
    );
    for (const lang of ["en", "ko", "ja"] as const) {
      expect(STRINGS[lang].ov_distill_done).not.toContain("{a}");
    }
  });

  it("a trashed-only run is not 'nothing to process'", () => {
    expect(formatRunOutcome(report({ trashed: 1 }), 0, 0, en)).toBe(
      "Distill finished — 0 days digested · 0 weeks rolled up · 0 proposals",
    );
  });

  // ROADMAP P1: a run whose ONLY work was the second compression layer must
  // not report "nothing to process" — that was the whole run.
  it("a weekly-rollup-only run is not 'nothing to process'", () => {
    expect(formatRunOutcome(report(), 0, 2, en)).toBe(
      "Distill finished — 0 days digested · 2 weeks rolled up · 0 proposals",
    );
  });
});

describe("llmStepsWaiting", () => {
  it("false when both steps ran with a provider (whatever the pending count)", () => {
    expect(
      llmStepsWaiting(
        { ingested: 2, skipped: null, errors: [] },
        { drafted: 1, skipped: null },
      ),
    ).toBe(false);
    expect(llmStepsWaiting(undefined, undefined)).toBe(false);
  });

  it("true when either step skipped for lack of a provider (builtin-local)", () => {
    expect(
      llmStepsWaiting({ ingested: 0, skipped: "no-provider", errors: [] }, undefined),
    ).toBe(true);
    expect(llmStepsWaiting(undefined, { drafted: 0, skipped: "no-provider" })).toBe(true);
  });

  it("a 'nothing' skip is not a provider wait", () => {
    expect(
      llmStepsWaiting({ ingested: 0, skipped: "nothing", errors: [] }, undefined),
    ).toBe(false);
  });
});

describe("pendingShrank", () => {
  it("true only when the count actually decreased since the last observation", () => {
    expect(pendingShrank(null, 3)).toBe(false); // no previous observation
    expect(pendingShrank(3, 3)).toBe(false); // unchanged
    expect(pendingShrank(3, 5)).toBe(false); // grew
    expect(pendingShrank(3, 2)).toBe(true);
  });
});

describe("lastRunLabel", () => {
  const now = Date.UTC(2026, 7, 13, 12, 0, 0); // 2026-08-13T12:00:00Z

  it("null when never run", () => {
    expect(lastRunLabel(null, "en", now)).toBeNull();
  });

  it("seconds ago", () => {
    expect(lastRunLabel(now / 1000 - 30, "en", now)).toBe("30 seconds ago");
  });

  it("minutes ago", () => {
    expect(lastRunLabel(now / 1000 - 5 * 60, "en", now)).toBe("5 minutes ago");
  });

  it("hours ago", () => {
    expect(lastRunLabel(now / 1000 - 3 * 3600, "en", now)).toBe("3 hours ago");
  });

  it("days ago", () => {
    expect(lastRunLabel(now / 1000 - 2 * 86_400, "en", now)).toBe("2 days ago");
  });

  // Settings audit item 6: lang (not the OS locale) drives Intl's locale —
  // regression guard against "마지막 실행 366 days ago" (English output on a
  // ko UI when Intl.RelativeTimeFormat was called with `undefined`).
  it("formats in Korean when lang is ko", () => {
    // 3 days (not 1-2, which Intl's "auto" mode idiomizes to "어제"/"그저께")
    // so the assertion targets the same "N일 전" pattern the bug produced in
    // English ("N days ago").
    expect(lastRunLabel(now / 1000 - 3 * 86_400, "ko", now)).toContain("일 전");
  });

  it("formats in Japanese when lang is ja", () => {
    expect(lastRunLabel(now / 1000 - 5 * 60, "ja", now)).toContain("分前");
  });
});

const REPORT: RunReport = {
  id: "r1",
  scan: {
    scored: 0,
    quarantined: 0,
    rejected: 0,
    summaries: 0,
    full: 0,
    skipped_immature: 0,
    gate_wiki_pages: null,
  },
  trashed: 0,
  proposals: 1,
  backlog_after: 0,
};

// The bug this guards against: schedule-due, count-trigger, and the manual
// button all decide to distill_run around the same moment, and a run can
// outlive the timer's 5-min poll — without a shared in-flight guard, two
// runs could interleave file moves.
describe("runDistillGuarded", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockOrganizationAdmission();
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ llm_ingest_budget: 3 } as DistillConfig);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("ENOENT: no such file or directory"));
    vi.spyOn(ipc, "resurfaceCandidates").mockResolvedValue([]);
    // Default: digest resolves with nothing to report (a bare vi.fn() would
    // return undefined and break the chain's .catch()).
    runSessionDigest.mockReset().mockResolvedValue({ daysDigested: 0, filesArchived: 0, skipped: "nothing", mode: "extractive" });
    runWeeklyRollup.mockReset().mockResolvedValue({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "extractive" });
    runMonthlyRollup.mockReset().mockResolvedValue({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "extractive" });
    runFullTierIngest.mockReset().mockResolvedValue({ ingested: 0, skipped: null, errors: [] });
  });

  it("a second concurrent call for the same vault gets null and makes no second ipc call", async () => {
    let release!: (r: RunReport) => void;
    const pending = new Promise<RunReport>((res) => {
      release = res;
    });
    const spy = vi.spyOn(ipc, "distillRun").mockReturnValue(pending);

    const first = runDistillGuarded("/v1");
    const second = await runDistillGuarded("/v1"); // first hasn't resolved yet
    expect(second).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);

    release(REPORT);
    expect(await first).toBe(REPORT);
  });

  // Owner decision 2026-10-03 (B1): every run, manual or automatic, leaves
  // raw/ alone, so there is no flag left to pass.
  it("keeps the native core call unchanged and binds foreground Full-tier to its opening", async () => {
    const spy = vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    await runDistillGuarded("/v-only");
    expect(spy.mock.calls).toEqual([["/v-only"]]);
    expect(runFullTierIngest.mock.calls).toEqual([["/v-only", {
      origin: { vaultPath: "/v-only", openingToken: "synthetic-organization-opening" }, usage: "foreground",
    }]]);
  });

  it("passes automatic execution and its original opening through the Full-tier boundary", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    await runDistillGuarded("/automatic-compilation", "automatic");
    expect(ipc.captureModelRole).toHaveBeenCalledWith(
      { vaultPath: "/automatic-compilation", openingToken: "synthetic-organization-opening" }, "organization", "automatic");
    expect(runFullTierIngest).toHaveBeenCalledWith("/automatic-compilation", {
      origin: { vaultPath: "/automatic-compilation", openingToken: "synthetic-organization-opening" }, usage: "automatic",
    });
  });

  it("allows a new run once the previous one resolves", async () => {
    const spy = vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    expect(await runDistillGuarded("/v2")).toBe(REPORT);
    expect(await runDistillGuarded("/v2")).toBe(REPORT);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not publish global success when the digest step fails", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    runSessionDigest.mockRejectedValue(new Error("synthetic digest failure"));
    await expect(runDistillGuarded("/synthetic-digest-failure")).rejects.toThrow("synthetic digest failure");
    expect(runWeeklyRollup).not.toHaveBeenCalled();
    expect(lastWorkflowReceipt.get("/synthetic-digest-failure")).toMatchObject({ status: "partial", issues: [{ step: "digest", status: "failed" }] });
    expect(useDistillRunStore.getState().outcome).toBe("error");
  });

  it("preserves pending evidence and refuses to start dependent rollups", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    runSessionDigest.mockResolvedValue({ daysDigested: 0, filesArchived: 0, filesPending: 2, status: "pending", mode: "llm", skipped: null });
    await expect(runDistillGuarded("/synthetic-pending")).rejects.toBeInstanceOf(WorkflowRunError);
    expect(lastWorkflowReceipt.get("/synthetic-pending")).toMatchObject({ status: "partial", steps: [{ step: "run" }, { step: "digest", status: "pending" }] });
    expect(runWeeklyRollup).not.toHaveBeenCalled();
  });

  it("keeps native failures failed and unlocks the vault for a retry", async () => {
    const core = vi.spyOn(ipc, "distillRun").mockRejectedValueOnce(new Error("synthetic ledger unavailable")).mockResolvedValueOnce(REPORT);
    await expect(runDistillGuarded("/synthetic-native-retry")).rejects.toMatchObject({ report: null, receipt: { status: "failed" } });
    expect(await runDistillGuarded("/synthetic-native-retry")).toBe(REPORT);
    expect(core).toHaveBeenCalledTimes(2);
  });

  it("does not treat an unreadable proposal tree as empty", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "listFiles").mockRejectedValue(new Error("synthetic tree unavailable"));
    await expect(runDistillGuarded("/synthetic-map-tree")).rejects.toThrow("synthetic tree unavailable");
    expect(lastWorkflowReceipt.get("/synthetic-map-tree")?.issues[0].step).toBe("maps");
  });

  it("does not treat unavailable prune status as a successfully refreshed index", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "embeddingsStatus").mockRejectedValue(new Error("synthetic index status unavailable"));
    runSessionDigest.mockResolvedValue({ daysDigested: 1, filesArchived: 1, skipped: null, mode: "extractive" });
    const previousVault = useVaultStore.getState().currentVault;
    useVaultStore.setState({ currentVault: { path: "/synthetic-prune-unavailable" } as never });
    try {
      await expect(runDistillGuarded("/synthetic-prune-unavailable")).rejects.toThrow("synthetic index status unavailable");
      expect(runWeeklyRollup).not.toHaveBeenCalled();
    } finally { useVaultStore.setState({ currentVault: previousVault }); }
  });

  it("different vaults don't block each other", async () => {
    let release!: (r: RunReport) => void;
    const pending = new Promise<RunReport>((res) => {
      release = res;
    });
    vi.spyOn(ipc, "distillRun").mockImplementation((v: string) =>
      v === "/a" ? pending : Promise.resolve(REPORT),
    );
    vi.mocked(ipc.agentVaultSession)
      .mockResolvedValueOnce({ vaultPath: "/b", openingToken: "synthetic-opening-b" })
      .mockResolvedValueOnce({ vaultPath: "/a", openingToken: "synthetic-opening-a" });
    const a = runDistillGuarded("/a");
    expect(await runDistillGuarded("/b")).toBe(REPORT);
    release(REPORT);
    expect(await a).toBe(REPORT);
  });

  // Spec 2026-10-02 decision 8 — one lock with the in-app auto-ingest pass.
  it("skips while an inbox pass holds the vault lock, and runs once it is let go", async () => {
    const spy = vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    expect(tryLock("/v-ingesting")).toBe(true); // what runInboxPass takes
    expect(await runDistillGuarded("/v-ingesting")).toBeNull();
    expect(spy).not.toHaveBeenCalled();

    unlock("/v-ingesting");
    expect(await runDistillGuarded("/v-ingesting")).toBe(REPORT);
  });

  it("holds the vault lock for the whole chain and lets it go after", async () => {
    let release!: (r: RunReport) => void;
    vi.spyOn(ipc, "distillRun").mockReturnValue(
      new Promise<RunReport>((res) => {
        release = res;
      }),
    );
    const run = runDistillGuarded("/v-chain");
    expect(tryLock("/v-chain")).toBe(false); // an inbox pass would skip here

    release(REPORT);
    await run;
    expect(tryLock("/v-chain")).toBe(true);
    unlock("/v-chain");
  });
});

// Cooperative stop: the flag is checked BETWEEN steps only — an in-flight
// step always finishes, then the chain skips every later step and records
// which step it stopped after (surfaced as "stopped after <step>" in the
// Settings distill tab).
describe("runDistillGuarded — cooperative stop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockOrganizationAdmission();
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ llm_ingest_budget: 3 } as DistillConfig);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("ENOENT: no such file or directory"));
    vi.spyOn(ipc, "resurfaceCandidates").mockResolvedValue([]);
    runSessionDigest.mockReset().mockResolvedValue({ daysDigested: 0, filesArchived: 0, skipped: "nothing", mode: "extractive" });
    runWeeklyRollup.mockReset().mockResolvedValue({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "extractive" });
    runMonthlyRollup.mockReset().mockResolvedValue({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "extractive" });
    runFullTierIngest.mockReset().mockResolvedValue({ ingested: 0, skipped: null, errors: [] });
  });

  it("a stop requested during the core run skips the whole LLM chain", async () => {
    vi.spyOn(ipc, "distillRun").mockImplementation(async (v: string) => {
      requestDistillStop(v); // e.g. the Stop button clicked mid-run
      return REPORT;
    });

    await expect(runDistillGuarded("/vstop-run")).rejects.toMatchObject({ report: REPORT, receipt: { status: "stopped" } });
    expect(useDistillRunStore.getState()).toMatchObject({ outcome: null, workflowStatus: "stopped" });
    expect(runSessionDigest).not.toHaveBeenCalled();
    expect(runFullTierIngest).not.toHaveBeenCalled();
    expect(lastStopPoint.get("/vstop-run")).toBe("run");
  });

  it("a stop requested during the digest lets it finish, then skips ingest and maps", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    const listFiles = vi.spyOn(ipc, "listFiles");
    runSessionDigest.mockImplementation(async (v: string) => {
      requestDistillStop(v);
      return { daysDigested: 0, filesArchived: 0, skipped: "nothing", mode: "extractive" };
    });

    await expect(runDistillGuarded("/vstop-digest")).rejects.toMatchObject({ report: REPORT, receipt: { status: "stopped" } });
    expect(runSessionDigest).toHaveBeenCalledTimes(1);
    expect(runFullTierIngest).not.toHaveBeenCalled();
    expect(listFiles).not.toHaveBeenCalled(); // draft-map apply never starts
    expect(lastStopPoint.get("/vstop-digest")).toBe("digest");
  });

  it("a stop requested during the weekly rollup lets it finish, then skips ingest and maps", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    runWeeklyRollup.mockImplementation(async (v: string) => {
      requestDistillStop(v);
      return { bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "extractive" };
    });

    await expect(runDistillGuarded("/vstop-weekly")).rejects.toMatchObject({ report: REPORT, receipt: { status: "stopped" } });
    expect(runSessionDigest).toHaveBeenCalledTimes(1);
    expect(runWeeklyRollup).toHaveBeenCalledTimes(1);
    expect(runFullTierIngest).not.toHaveBeenCalled();
    expect(lastStopPoint.get("/vstop-weekly")).toBe("weekly");
  });

  it("a stop requested during ingest skips only the draft-map step", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    const getSettings = vi.spyOn(ipc, "getSettings");
    runFullTierIngest.mockImplementation(async (v: string) => {
      requestDistillStop(v);
      return { ingested: 0, skipped: null, errors: [] };
    });

    await expect(runDistillGuarded("/vstop-ingest")).rejects.toMatchObject({ receipt: { status: "stopped" } });

    expect(runFullTierIngest).toHaveBeenCalledTimes(1);
    expect(getSettings).not.toHaveBeenCalled(); // draft-map apply never starts
    expect(lastStopPoint.get("/vstop-ingest")).toBe("ingest");
  });

  it("a run without a stop records null, and the flag never leaks into the next run", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      query_provider: "builtin-local",
    } as never);

    // Stop the first run mid-digest…
    runSessionDigest.mockImplementationOnce(async (v: string) => {
      requestDistillStop(v);
      return { daysDigested: 0, filesArchived: 0, skipped: "nothing", mode: "extractive" };
    });
    await expect(runDistillGuarded("/vstop-clean")).rejects.toMatchObject({ receipt: { status: "stopped" } });
    expect(lastStopPoint.get("/vstop-clean")).toBe("digest");

    // …the next run for the same vault runs the full chain again.
    await runDistillGuarded("/vstop-clean");
    expect(runFullTierIngest).toHaveBeenCalledTimes(1);
    expect(lastStopPoint.get("/vstop-clean")).toBeNull();
  });

  it("a stop request while nothing is in flight is a no-op", async () => {
    requestDistillStop("/vidle");
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      query_provider: "builtin-local",
    } as never);

    await runDistillGuarded("/vidle");

    expect(runSessionDigest).toHaveBeenCalledTimes(1);
    expect(lastStopPoint.get("/vidle")).toBeNull();
  });
});

// Phase B, Task 4 — the Aggressive-intensity bridge: distill_run writes
// `draft-map` proposals straight to `status: approved` at that intensity, so
// runDistillGuarded must apply them the same way PageFeedback's approve
// button would, without waiting for a human click.
describe("runDistillGuarded — draft-map auto-apply (Aggressive bridge)", () => {
  const feedbackTree = (names: string[]): FileNode[] => [
    {
      kind: "directory",
      name: "work",
      path: "/vmap/work",
      children: [
        {
          kind: "directory",
          name: "feedback",
          path: "/vmap/work/feedback",
          children: names.map((n) => ({
            kind: "file" as const,
            name: n,
            path: `/vmap/work/feedback/${n}`,
          })),
        },
      ],
    },
  ];
  const TREE = feedbackTree(["p.md"]);

  const proposal = (status: string, cluster = "attention"): string =>
    "---\n" +
    "type: distill-proposal\n" +
    "action: draft-map\n" +
    `status: ${status}\n` +
    "created: 2026-08-13\n" +
    `payload: {"cluster":"${cluster}","members":["wiki/a.md","wiki/b.md"]}\n` +
    `---\n\n# Map candidate: ${cluster}\n\nbody\n`;

  // Organization is explicitly selected; connection and legacy fields confer no consent.
  const settings = (organizationProvider: string): MycoSettings => {
    organizationChoice = { providerId: organizationProvider,
      modelId: organizationProvider === "builtin-local" ? "extractive-ingest" : "synthetic-writer" };
    return { model_roles: selectedRolesFixture({ organization: organizationChoice }) } as MycoSettings;
  };

  const CFG = { llm_ingest_budget: 3 } as unknown as DistillConfig;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockOrganizationAdmission();
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ llm_ingest_budget: 3 } as DistillConfig);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("ENOENT: no such file or directory"));
    vi.spyOn(ipc, "resurfaceCandidates").mockResolvedValue([]);
    draftMap.mockReset();
    runSessionDigest.mockReset().mockResolvedValue({ daysDigested: 0, filesArchived: 0, skipped: "nothing", mode: "extractive" });
    runWeeklyRollup.mockReset().mockResolvedValue({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "extractive" });
    runMonthlyRollup.mockReset().mockResolvedValue({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "extractive" });
    runFullTierIngest.mockReset().mockResolvedValue({ ingested: 0, skipped: null, errors: [] });
  });

  it("applies an approved draft-map proposal and marks it done", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("anthropic-api"));
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(TREE);
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/vmap/work/feedback/p.md",
      raw: proposal("approved"),
      content: "",
      frontmatter: {},
    });
    const writeFile = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    draftMap.mockResolvedValue("wiki/maps/attention.md");

    await runDistillGuarded("/vmap");

    expect(draftMap).toHaveBeenCalledWith(
      "/vmap",
      "attention",
      ["wiki/a.md", "wiki/b.md"],
      expect.stringMatching(/^llm-\d+$/),
      undefined, "foreground", roleFixture("organization", "anthropic-api", "synthetic-writer",
        { vaultPath: "/vmap", openingToken: "synthetic-organization-opening" }),
    );
    expect(writeFile).toHaveBeenCalledWith(
      "/vmap/work/feedback/p.md",
      expect.stringContaining("status: done"),
    );
  });

  it("preserves a published map's pending manifest without completing its proposal", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("anthropic-api"));
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(TREE);
    vi.spyOn(ipc, "readFile").mockResolvedValue({ path: "/vmap/work/feedback/p.md", raw: proposal("approved"), content: "", frontmatter: {} });
    const write = vi.spyOn(ipc, "writeFile");
    draftMap.mockRejectedValue(Object.assign(new WorkflowOperationError("pending", "unavailable", "synthetic manifest unavailable"),
      { writtenPath: "wiki/maps/attention.md" }));
    await expect(runDistillGuarded("/vmap")).rejects.toMatchObject({ receipt: { status: "partial",
      steps: expect.arrayContaining([expect.objectContaining({ step: "maps", status: "partial" })]) } });
    expect(write).not.toHaveBeenCalled();
    expect(lastWorkflowReceipt.get("/vmap")?.issues[0]).toMatchObject({ status: "pending", code: "unavailable" });
  });

  it("leaves a pending draft-map proposal untouched", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("anthropic-api"));
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(TREE);
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/vmap/work/feedback/p.md",
      raw: proposal("pending"),
      content: "",
      frontmatter: {},
    });
    const writeFile = vi.spyOn(ipc, "writeFile");

    await runDistillGuarded("/vmap");

    expect(draftMap).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("drafts with the explicitly selected Organization writer while Ask is extractive", async () => {
    // Ask and Compilation do not lend their selection to Organization.
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ...settings("anthropic-api"),
      model_roles: selectedRolesFixture({
        ask: { providerId: "builtin-local", modelId: "extractive-retrieval" },
        organization: organizationChoice,
      }),
    });
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(TREE);
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/vmap/work/feedback/p.md",
      raw: proposal("approved"),
      content: "",
      frontmatter: {},
    });
    vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    draftMap.mockResolvedValue("wiki/maps/attention.md");

    await runDistillGuarded("/vmap");

    expect(draftMap).toHaveBeenCalledTimes(1);
  });

  it("uses the captured Organization route after settings change before the map gate", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    organizationChoice = { providerId: "builtin-local", modelId: BUILTIN_CHAT_MODEL };
    const settingsRead = vi.mocked(ipc.getSettings).mockResolvedValue(settings("builtin-local"));
    organizationChoice = { providerId: "builtin-local", modelId: BUILTIN_CHAT_MODEL };
    vi.spyOn(ipc, "listFiles").mockResolvedValue(TREE);
    vi.spyOn(ipc, "readFile").mockResolvedValue({ path: "/vmap/work/feedback/p.md", raw: proposal("approved"), content: "", frontmatter: {} });
    vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    draftMap.mockResolvedValue("wiki/maps/attention.md");
    await runDistillGuarded("/vmap");
    const grant = roleFixture("organization", "builtin-local", BUILTIN_CHAT_MODEL,
      { vaultPath: "/vmap", openingToken: "synthetic-organization-opening" });
    expect(draftMap).toHaveBeenCalledWith("/vmap", "attention", ["wiki/a.md", "wiki/b.md"], expect.stringMatching(/^llm-\d+$/), undefined, "foreground", grant);
    expect(settingsRead).not.toHaveBeenCalled();
  });

  it("makes zero draft calls on builtin-local (final-review Important 3)", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("builtin-local"));
    const listFiles = vi.spyOn(ipc, "listFiles");

    await runDistillGuarded("/vmap");

    expect(draftMap).not.toHaveBeenCalled();
    // The tree IS walked now — emptiness outranks the provider check, so
    // the walk is what proves there is nothing approved (skipped: null on
    // an empty tree, no-provider only with real approved proposals).
    expect(listFiles).toHaveBeenCalled();
  });

  it("triggers a prune reindex after a digest that archived files (final-review Important 6)", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    // builtin-local everywhere: full-tier and draft-map self-skip, isolating
    // the prune path.
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("builtin-local"));
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 42,
      model: "builtin-local:m",
    } as EmbeddingsStatus);
    runSessionDigest.mockResolvedValue({ daysDigested: 1, filesArchived: 3, skipped: null });

    const prevVault = useVaultStore.getState().currentVault;
    const prevReindex = useReindexStore.getState().reindex;
    const reindex = vi.fn().mockImplementation(async () => { useReindexStore.setState({ stage: "done", error: null }); });
    useVaultStore.setState({ currentVault: { path: "/vprune" } as never });
    useReindexStore.setState({ reindex });
    try {
      await runDistillGuarded("/vprune");
      expect(reindex).toHaveBeenCalledTimes(1);
    } finally {
      useVaultStore.setState({ currentVault: prevVault });
      useReindexStore.setState({ reindex: prevReindex });
    }
  });

  it("triggers a prune reindex after a weekly rollup that archived daily notes", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("builtin-local"));
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 42,
      model: "builtin-local:m",
    } as EmbeddingsStatus);
    // Only the weekly layer did anything: daily/archive/ is cold too, so the
    // active index still holds those records until this prune.
    runWeeklyRollup.mockResolvedValue({
      bucketsRolledUp: 1,
      sourcesArchived: 7,
      skipped: null,
      mode: "extractive",
    });

    const prevVault = useVaultStore.getState().currentVault;
    const prevReindex = useReindexStore.getState().reindex;
    const reindex = vi.fn().mockImplementation(async () => { useReindexStore.setState({ stage: "done", error: null }); });
    useVaultStore.setState({ currentVault: { path: "/vprune" } as never });
    useReindexStore.setState({ reindex });
    try {
      await runDistillGuarded("/vprune");
      expect(reindex).toHaveBeenCalledTimes(1);
    } finally {
      useVaultStore.setState({ currentVault: prevVault });
      useReindexStore.setState({ reindex: prevReindex });
    }
  });

  it("indexes partial evidence even when the original sessions remain active", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("builtin-local"));
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 42, model: "builtin-local:m" } as EmbeddingsStatus);
    runSessionDigest.mockResolvedValue({ daysDigested: 0, filesArchived: 0, filesPending: 1, chunksProcessed: 48, skipped: null });
    const prevVault = useVaultStore.getState().currentVault;
    const prevReindex = useReindexStore.getState().reindex;
    const reindex = vi.fn().mockImplementation(async () => { useReindexStore.setState({ stage: "done", error: null }); });
    useVaultStore.setState({ currentVault: { path: "/vpartial" } as never });
    useReindexStore.setState({ reindex });
    try {
      await expect(runDistillGuarded("/vpartial")).rejects.toMatchObject({ receipt: { status: "partial" } });
      expect(reindex).toHaveBeenCalledTimes(1);
    } finally {
      useVaultStore.setState({ currentVault: prevVault });
      useReindexStore.setState({ reindex: prevReindex });
    }
  });

  it("never triggers a FIRST index build as a prune side effect", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("builtin-local"));
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 0, // no index yet — the first build stays a deliberate action
      model: "",
    } as EmbeddingsStatus);
    runSessionDigest.mockResolvedValue({ daysDigested: 1, filesArchived: 3, skipped: null });

    const prevVault = useVaultStore.getState().currentVault;
    const prevReindex = useReindexStore.getState().reindex;
    const reindex = vi.fn();
    useVaultStore.setState({ currentVault: { path: "/vprune" } as never });
    useReindexStore.setState({ reindex });
    try {
      await runDistillGuarded("/vprune");
      expect(reindex).not.toHaveBeenCalled();
    } finally {
      useVaultStore.setState({ currentVault: prevVault });
      useReindexStore.setState({ reindex: prevReindex });
    }
  });

  it("caps one run's draft applies at llm_ingest_budget", async () => {
    const names = ["p1.md", "p2.md", "p3.md", "p4.md", "p5.md"];
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("anthropic-api"));
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG); // budget 3
    vi.spyOn(ipc, "listFiles").mockResolvedValue(feedbackTree(names));
    vi.spyOn(ipc, "readFile").mockImplementation((path: string) =>
      Promise.resolve({
        path,
        raw: proposal("approved", path.split("/").pop()!.replace(".md", "")),
        content: "",
        frontmatter: {},
      }),
    );
    const writeFile = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    draftMap.mockResolvedValue("wiki/maps/x.md");

    await expect(runDistillGuarded("/vmap")).rejects.toMatchObject({ receipt: { status: "partial" } });

    expect(draftMap).toHaveBeenCalledTimes(3);
    expect(writeFile).toHaveBeenCalledTimes(3);
  });

  // Manifest fragmentation fix: every map one run drafts must land in ONE
  // undo-manifest, or the Settings "undo last run" button (which only sees
  // the newest manifest id) reverses just the last map.
  it("passes one shared manifest id to every draftMap of a run", async () => {
    const names = ["p1.md", "p2.md", "p3.md"];
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("anthropic-api"));
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(feedbackTree(names));
    vi.spyOn(ipc, "readFile").mockImplementation((path: string) =>
      Promise.resolve({
        path,
        raw: proposal("approved", path.split("/").pop()!.replace(".md", "")),
        content: "",
        frontmatter: {},
      }),
    );
    vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    draftMap.mockResolvedValue("wiki/maps/x.md");

    await runDistillGuarded("/vmap");

    const ids = draftMap.mock.calls.map((c) => c[3]);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^llm-\d+$/);
    expect(new Set(ids).size).toBe(1);
  });

  // Settings audit item 2: llm_ingest_budget is a SHARED per-run cap over
  // full-tier ingest AND draft-map auto-apply, not one full budget for each.
  it("caps draft-map applies at what full-tier ingest left of the shared budget", async () => {
    const names = ["p1.md", "p2.md", "p3.md", "p4.md", "p5.md"];
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("anthropic-api"));
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG); // budget 3
    runFullTierIngest.mockResolvedValue({ ingested: 2, skipped: null, errors: [] });
    vi.spyOn(ipc, "listFiles").mockResolvedValue(feedbackTree(names));
    vi.spyOn(ipc, "readFile").mockImplementation((path: string) =>
      Promise.resolve({
        path,
        raw: proposal("approved", path.split("/").pop()!.replace(".md", "")),
        content: "",
        frontmatter: {},
      }),
    );
    const writeFile = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    draftMap.mockResolvedValue("wiki/maps/x.md");

    await expect(runDistillGuarded("/vmap")).rejects.toMatchObject({ receipt: { status: "partial" } });

    // budget 3 - 2 already spent by full-tier ingest = 1 left for maps.
    expect(draftMap).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});

// Q4 item 10 — the post-run resurface hook: today's daily note seeds
// resurface_candidates, the store gets the surviving picks, and any failure
// is the hook's own problem, never the run's.
describe("runDistillGuarded — resurface hook", () => {
  const DAILY = {
    path: "/vres/daily/today.md",
    raw: "---\ntitle: today\n---\nseed body",
    content: "seed body",
    frontmatter: {},
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockOrganizationAdmission();
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ llm_ingest_budget: 3 } as DistillConfig);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("ENOENT: no such file or directory"));
    vi.spyOn(ipc, "resurfaceCandidates").mockResolvedValue([]);
    runSessionDigest.mockReset().mockResolvedValue({ daysDigested: 0, filesArchived: 0, skipped: "nothing", mode: "extractive" });
    runWeeklyRollup.mockReset().mockResolvedValue({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "extractive" });
    runMonthlyRollup.mockReset().mockResolvedValue({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "extractive" });
    runFullTierIngest.mockReset().mockResolvedValue({ ingested: 0, skipped: null, errors: [] });
    useResurfaceStore.setState({ picks: [], computedAt: null, floor: 0.7 });
  });

  it("seeds resurface with today's daily note (frontmatter stripped) and stores the picks", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]); // no draft-map proposals
    const readFile = vi.spyOn(ipc, "readFile").mockResolvedValue(DAILY);
    const resurface = vi.spyOn(ipc, "resurfaceCandidates").mockResolvedValue([
      { page: "wiki/a.md", stem: "a", score: 0.91, snippet: "s", last_open: null },
    ]);

    await runDistillGuarded("/vres");

    expect(readFile).toHaveBeenCalledWith(
      expect.stringMatching(/^\/vres\/daily\/\d{4}-\d{2}-\d{2}\.md$/),
    );
    expect(resurface).toHaveBeenCalledWith("/vres", "seed body", 6, 0.7);
    expect(useResurfaceStore.getState().picks).toEqual([
      { page: "wiki/a.md", stem: "a", score: 0.91, snippet: "s", lastOpen: null },
    ]);
    expect(lastResurfaceOutcome.get("/vres")).toEqual({ shown: 1 });
  });

  it("skips quietly when today's daily note does not exist", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("not found"));
    const resurface = vi.spyOn(ipc, "resurfaceCandidates");

    await runDistillGuarded("/vres-none");

    expect(resurface).not.toHaveBeenCalled();
    expect(lastResurfaceOutcome.get("/vres-none")).toBeUndefined();
  });

  it("records a resurface failure without publishing whole-chain success", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readFile").mockResolvedValue(DAILY);
    vi.spyOn(ipc, "resurfaceCandidates").mockRejectedValue(new Error("model gone"));

    await expect(runDistillGuarded("/vres-err")).rejects.toMatchObject({ report: REPORT, receipt: { status: "partial" } });
    expect(lastWorkflowReceipt.get("/vres-err")?.issues[0]).toMatchObject({ step: "resurface", status: "failed" });
  });

  it("a stop requested during the maps step skips resurface and records 'maps'", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "getDistillConfig").mockImplementation(async (v: string) => {
      requestDistillStop(v); // Stop clicked while the maps step runs
      return { llm_ingest_budget: 3 } as DistillConfig;
    });
    const readFile = vi.spyOn(ipc, "readFile");
    const resurface = vi.spyOn(ipc, "resurfaceCandidates");

    await expect(runDistillGuarded("/vstop-maps")).rejects.toMatchObject({ receipt: { status: "stopped" } });

    expect(readFile).not.toHaveBeenCalled();
    expect(resurface).not.toHaveBeenCalled();
    expect(lastStopPoint.get("/vstop-maps")).toBe("maps");
  });
});
