import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runDistillGuarded = vi.fn();
vi.mock("./distill", () => ({
  runDistillGuarded: (...a: unknown[]) => runDistillGuarded(...a),
}));

import { markActivity, maybeAutoDistill } from "./autoDistill";
import { ipc } from "./ipc";
import type { DistillConfig, DistillStatus } from "./distill";

const CFG: DistillConfig = {
  enabled: true,
  count_trigger: 50,
  intensity: "standard",
  gate_preset: "normal",
  quarantine_ttl_days: 30,
  run_budget_items: 50,
  idle_minutes: 10,
  maturation_hours: 24,
  dormancy_decay: false,
  llm_digest_days: 3,
  llm_ingest_budget: 3,
  profile_injection: true,
};

const status = (backlog: number): DistillStatus => ({
  backlog,
  pending_proposals: 0,
  last_run: null,
  last_backlogs: [],
  gate_active: true,
  last_run_id: null,
  wiki_pages: 60,
  quarantined: 0,
});

const MIN = 60_000;

// Spec 2026-10-02 decisions 6-7. The cooldown is kept per vault in module
// state, so every test uses its own vault path.
describe("maybeAutoDistill", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    runDistillGuarded.mockReset().mockResolvedValue({ id: "synthetic-success" });
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    markActivity();
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG);
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(status(60));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once idle for idle_minutes with the backlog at count_trigger, and leaves raw/ alone", async () => {
    vi.advanceTimersByTime(10 * MIN);
    await maybeAutoDistill("/fire");
    expect(runDistillGuarded).toHaveBeenCalledTimes(1);
    expect(runDistillGuarded).toHaveBeenCalledWith("/fire", "automatic");
  });

  it("does nothing while 자동 정리 is off", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ ...CFG, enabled: false });
    vi.advanceTimersByTime(60 * MIN);
    await maybeAutoDistill("/off");
    expect(runDistillGuarded).not.toHaveBeenCalled();
  });

  it("does nothing while the user is not idle yet", async () => {
    vi.advanceTimersByTime(9 * MIN);
    await maybeAutoDistill("/busy");
    vi.advanceTimersByTime(5 * MIN);
    markActivity(); // a key or the pointer resets the clock
    vi.advanceTimersByTime(5 * MIN);
    await maybeAutoDistill("/busy");
    expect(runDistillGuarded).not.toHaveBeenCalled();
  });

  it("does nothing under the count, or with count_trigger 0", async () => {
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(status(49));
    vi.advanceTimersByTime(10 * MIN);
    await maybeAutoDistill("/under");
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ ...CFG, count_trigger: 0 });
    await maybeAutoDistill("/zero");
    expect(runDistillGuarded).not.toHaveBeenCalled();
  });

  it("runs at most once per 60 minutes per vault", async () => {
    vi.advanceTimersByTime(10 * MIN);
    await maybeAutoDistill("/cool");
    vi.advanceTimersByTime(59 * MIN);
    await maybeAutoDistill("/cool");
    expect(runDistillGuarded).toHaveBeenCalledTimes(1);
    await maybeAutoDistill("/cool-other"); // another vault is not held back
    expect(runDistillGuarded).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1 * MIN);
    await maybeAutoDistill("/cool");
    expect(runDistillGuarded).toHaveBeenCalledTimes(3);
  });

  it("logs a failed run instead of throwing out of the poll", async () => {
    runDistillGuarded.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.advanceTimersByTime(10 * MIN);
    await expect(maybeAutoDistill("/fail")).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it("retries after the shared lock skipped the run without consuming the success cooldown", async () => {
    runDistillGuarded.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "synthetic-success" });
    vi.advanceTimersByTime(10 * MIN);
    await maybeAutoDistill("/synthetic-lock-skip");
    await maybeAutoDistill("/synthetic-lock-skip");
    expect(runDistillGuarded).toHaveBeenCalledTimes(2);
  });

  it("retries a failed chain without consuming the success cooldown", async () => {
    runDistillGuarded.mockRejectedValueOnce(new Error("synthetic incomplete workflow")).mockResolvedValueOnce({ id: "synthetic-success" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.advanceTimersByTime(10 * MIN);
    await maybeAutoDistill("/synthetic-workflow-retry");
    await maybeAutoDistill("/synthetic-workflow-retry");
    expect(runDistillGuarded).toHaveBeenCalledTimes(2);
  });
});
