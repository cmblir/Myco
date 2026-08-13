import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolates the "digest-kind schedules are unaffected" test below from the
// real digest pipeline (file writes, prompt building) — only whether
// scheduleStore.runNow reached it matters here.
const runDigest = vi.fn();
vi.mock("./digests", () => ({
  runDigest: (...a: unknown[]) => runDigest(...a),
}));

import { useScheduleStore } from "../stores/scheduleStore";
import { useVaultStore } from "../stores/vaultStore";
import { ipc } from "./ipc";
import { markActivity } from "./idle";
import { runDueSchedules } from "./scheduleTimer";
import type { Schedule } from "./ipc";
import type { DistillConfig, RunReport } from "./distill";

// Regression: a due "distill"-kind schedule used to run unconditionally,
// same as every other kind — the brief requires it to wait for the user to
// be idle, deferring (not stamping last_run) until then.

const CFG: DistillConfig = {
  enabled: true,
  count_trigger: 0, // disabled-by-count: isolates this from the count-trigger path
  intensity: "standard",
  gate_preset: "normal",
  quarantine_ttl_days: 30,
  run_budget_items: 50,
  idle_minutes: 5,
  maturation_hours: 24,
  dormancy_decay: false,
  llm_digest_days: 3,
  llm_ingest_budget: 3,
  profile_injection: true,
};

const REPORT: RunReport = {
  id: "r1",
  scan: {
    scored: 0,
    quarantined: 0,
    rejected: 0,
    summaries: 0,
    full: 0,
    skipped_immature: 0,
  },
  archived: 0,
  trashed: 0,
  proposals: 0,
  backlog_after: 0,
};

const distillSchedule: Schedule = {
  id: "d1",
  title: "Nightly distill",
  kind: "distill",
  prompt: "",
  cadence: "daily",
  output_dir: "digests",
  provider: "",
  model: "",
  notify: false,
  last_run: null,
  enabled: true,
};

describe("runDueSchedules — idle-gated distill schedule", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    markActivity(); // baseline: user just active
    useScheduleStore.setState({
      schedules: [],
      runningId: null,
      error: null,
      lastDigestPath: null,
      loading: false,
    });
    useVaultStore.setState({ currentVault: null });
    vi.spyOn(ipc, "listSchedules").mockResolvedValue([distillSchedule]);
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG);
    vi.spyOn(ipc, "upsertSchedule").mockImplementation(async (_v, s) => [s]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers a due distill schedule while the user is active — no ipc call, last_run unstamped", async () => {
    const runSpy = vi.spyOn(ipc, "distillRun");
    await runDueSchedules("/v");
    expect(runSpy).not.toHaveBeenCalled();
    expect(useScheduleStore.getState().schedules[0].last_run).toBeNull();
  });

  it("runs it once the user has been idle for idle_minutes, and stamps last_run", async () => {
    const runSpy = vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.advanceTimersByTime(5 * 60_000);
    await runDueSchedules("/v");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(useScheduleStore.getState().schedules[0].last_run).not.toBeNull();
  });
});

// Regression: DistillConfig.enabled was only consulted by the count-trigger
// (maybeRunCountTrigger) — a due "distill"-kind schedule ran unconditionally
// even with the "자동 증류" toggle off. It must defer like the idle case
// above: no ipc call, last_run left untouched. Every other schedule kind
// (routed through the digest pipeline, not distill_run) must stay unaffected.
describe("runDueSchedules — distill schedules respect the enabled toggle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    runDigest.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    markActivity();
    // Idle long enough that the idle gate alone would let it through —
    // isolates the enabled check from the idle check above.
    vi.advanceTimersByTime(10 * 60_000);
    useScheduleStore.setState({
      schedules: [],
      runningId: null,
      error: null,
      lastDigestPath: null,
      loading: false,
    });
    useVaultStore.setState({ currentVault: null });
    vi.spyOn(ipc, "listSchedules").mockResolvedValue([distillSchedule]);
    vi.spyOn(ipc, "upsertSchedule").mockImplementation(async (_v, s) => [s]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers a due distill schedule while disabled — no ipc call, last_run unstamped", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ ...CFG, enabled: false });
    const runSpy = vi.spyOn(ipc, "distillRun");
    await runDueSchedules("/v");
    expect(runSpy).not.toHaveBeenCalled();
    expect(useScheduleStore.getState().schedules[0].last_run).toBeNull();
  });

  it("non-distill (digest-pipeline) schedules are unaffected by the distill enabled toggle", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ ...CFG, enabled: false });
    runDigest.mockResolvedValue("digests/x.md");
    const digestSchedule: Schedule = { ...distillSchedule, id: "s1", kind: "query" };
    vi.spyOn(ipc, "listSchedules").mockResolvedValue([digestSchedule]);
    await runDueSchedules("/v");
    expect(runDigest).toHaveBeenCalledTimes(1);
    expect(useScheduleStore.getState().schedules[0].last_run).not.toBeNull();
  });
});
