import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DistillConfig } from "./distill";

const complete = vi.fn();
const getActiveModel = vi.fn();
vi.mock("./chat", () => ({
  complete: (...a: unknown[]) => complete(...a),
  getActiveModel: (...a: unknown[]) => getActiveModel(...a),
}));

const getDistillConfig = vi.fn();
const digestableSessionDays = vi.fn();
const archiveDigestedSessions = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const createFolder = vi.fn();
const createFile = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    getDistillConfig: (...a: unknown[]) => getDistillConfig(...a),
    digestableSessionDays: (...a: unknown[]) => digestableSessionDays(...a),
    archiveDigestedSessions: (...a: unknown[]) => archiveDigestedSessions(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    createFolder: (...a: unknown[]) => createFolder(...a),
    createFile: (...a: unknown[]) => createFile(...a),
  },
}));

import { runSessionDigest, DIGEST_SYSTEM } from "./sessionDigest";

const CFG: DistillConfig = {
  enabled: true,
  count_trigger: 50,
  intensity: "standard",
  gate_preset: "normal",
  quarantine_ttl_days: 30,
  run_budget_items: 50,
  idle_minutes: 5,
  maturation_hours: 24,
  dormancy_decay: false,
  llm_digest_days: 1,
  llm_ingest_budget: 3,
  profile_injection: true,
};

// Shared session-file content stub for readFile — used both for the session
// logs (path under /sessions/) and the daily-note check (path under /daily/,
// mocked to "not found" so the append path creates the file fresh).
function mockReadFile(dailyExisting: string | null = null): void {
  readFile.mockImplementation(async (path: string) => {
    if (path.includes("/daily/")) {
      if (dailyExisting !== null) {
        return { path, raw: dailyExisting, content: dailyExisting, frontmatter: null };
      }
      throw new Error("not found");
    }
    return { path, raw: "user did X, decided Y", content: "user did X, decided Y", frontmatter: null };
  });
}

beforeEach(() => {
  complete.mockReset();
  getActiveModel.mockReset();
  getDistillConfig.mockReset();
  digestableSessionDays.mockReset();
  archiveDigestedSessions.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  createFolder.mockReset();
  createFile.mockReset();
  createFolder.mockResolvedValue("daily");
  createFile.mockResolvedValue("daily/x.md");
  writeFile.mockResolvedValue(null);
  archiveDigestedSessions.mockResolvedValue("digest-archived");
});

describe("DIGEST_SYSTEM", () => {
  it("instructs bullets-only extraction with an uncertainty marker", () => {
    expect(DIGEST_SYSTEM).toContain("(uncertain)");
  });
});

describe("runSessionDigest", () => {
  it("skips with no-provider when the active query model is builtin-local, and never touches archiving", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "" });

    const result = await runSessionDigest("/v");

    expect(result).toEqual({ daysDigested: 0, filesArchived: 0, skipped: "no-provider" });
    expect(digestableSessionDays).not.toHaveBeenCalled();
    expect(archiveDigestedSessions).not.toHaveBeenCalled();
  });

  it("skips with nothing when there are no digestable days", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([]);

    const result = await runSessionDigest("/v");

    expect(result).toEqual({ daysDigested: 0, filesArchived: 0, skipped: "nothing" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("digests only the first llm_digest_days day, one complete() call, one archive call, and appends the daily note", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG); // llm_digest_days: 1
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"], bytes: 100 },
      { day: "2026-08-11", files: ["sessions/2026-08-11/b.md"], bytes: 100 },
    ]);
    mockReadFile();
    complete.mockResolvedValue("- Decided to use X\n- Shipped Y (uncertain)");

    const result = await runSessionDigest("/v");

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toMatchObject({
      task: "query",
      cwd: "/v",
    });
    expect(complete.mock.calls[0][0].messages[0]).toEqual({
      role: "system",
      content: DIGEST_SYSTEM,
    });
    expect(archiveDigestedSessions).toHaveBeenCalledTimes(1);
    expect(archiveDigestedSessions).toHaveBeenCalledWith(
      "/v",
      "2026-08-10",
      ["sessions/2026-08-10/a.md"],
    );
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0];
    expect(path).toBe("/v/daily/2026-08-10.md");
    expect(content).toContain("## Session digest (auto)");
    expect(content).toContain("low confidence");
    expect(content).toContain("Decided to use X");
    expect(result).toEqual({ daysDigested: 1, filesArchived: 1, skipped: null });
  });

  it("appends under a sub-line instead of duplicating the header when one already exists for that day", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"], bytes: 100 },
    ]);
    mockReadFile("# 2026-08-10\n\n## Session digest (auto)\n_from 2 session logs — low confidence_\n- Earlier bullet\n");
    complete.mockResolvedValue("- New bullet");

    await runSessionDigest("/v");

    const content = writeFile.mock.calls[0][1] as string;
    expect(content.match(/## Session digest \(auto\)/g)).toHaveLength(1);
    expect(content).toContain("_run of ");
    expect(content).toContain("New bullet");
    expect(content).toContain("Earlier bullet");
  });

  it("does not archive a day whose complete() call rejects, and stops there", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue({ ...CFG, llm_digest_days: 2 });
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"], bytes: 100 },
      { day: "2026-08-11", files: ["sessions/2026-08-11/b.md"], bytes: 100 },
    ]);
    mockReadFile();
    complete.mockRejectedValue(new Error("provider boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runSessionDigest("/v");

    expect(archiveDigestedSessions).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(result).toEqual({ daysDigested: 0, filesArchived: 0, skipped: null });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
