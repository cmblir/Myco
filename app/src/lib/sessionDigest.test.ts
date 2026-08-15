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
const appendDistillManifest = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const createFolder = vi.fn();
const createFile = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    getDistillConfig: (...a: unknown[]) => getDistillConfig(...a),
    digestableSessionDays: (...a: unknown[]) => digestableSessionDays(...a),
    archiveDigestedSessions: (...a: unknown[]) => archiveDigestedSessions(...a),
    appendDistillManifest: (...a: unknown[]) => appendDistillManifest(...a),
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
  appendDistillManifest.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  createFolder.mockReset();
  createFile.mockReset();
  createFolder.mockResolvedValue("daily");
  createFile.mockResolvedValue("daily/x.md");
  writeFile.mockResolvedValue(null);
  archiveDigestedSessions.mockResolvedValue("digest-archived");
  appendDistillManifest.mockResolvedValue(null);
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
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"] },
      { day: "2026-08-11", files: ["sessions/2026-08-11/b.md"] },
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
    // Important 4 (Phase B whole-branch review): the daily file was created
    // fresh (mockReadFile()'s default "not found" for /daily/), so its
    // creation is folded into archiveDigestedSessions' own manifest id.
    expect(appendDistillManifest).toHaveBeenCalledWith(
      "/v",
      "digest-archived",
      [],
      ["daily/2026-08-10.md"],
    );
    // Defect C fix: the SAME write that carries the digest text names the
    // session files it covers, so there is no window where the digest is
    // durable but the record of it isn't. Rust's digested_session_stems parses
    // this line back.
    expect(content).toContain("<!-- myco:digested-sessions a -->");
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("skips the LLM call and re-appending for a day whose files are already recorded, and only retries the archive", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"], already_digested: true },
    ]);

    const result = await runSessionDigest("/v");

    expect(complete).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(archiveDigestedSessions).toHaveBeenCalledTimes(1);
    expect(archiveDigestedSessions).toHaveBeenCalledWith(
      "/v",
      "2026-08-10",
      ["sessions/2026-08-10/a.md"],
    );
    expect(result).toEqual({ daysDigested: 1, filesArchived: 1, skipped: null });
  });

  it("stops (without re-running the LLM) when the retried archive for an already-digested day fails again", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"], already_digested: true },
    ]);
    archiveDigestedSessions.mockRejectedValue(new Error("disk full"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runSessionDigest("/v");

    expect(complete).not.toHaveBeenCalled();
    expect(result).toEqual({ daysDigested: 0, filesArchived: 0, skipped: null });
    errSpy.mockRestore();
  });

  it("marks files dropped by the shared 60k budget in the prompt sent to the model", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      {
        day: "2026-08-10",
        files: [
          "sessions/2026-08-10/a.md",
          "sessions/2026-08-10/b.md",
          "sessions/2026-08-10/c.md",
        ],
      },
    ]);
    const big = "x".repeat(50_000); // two of these saturate the 60k pool
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/daily/")) throw new Error("not found");
      if (path.endsWith("c.md")) {
        return { path, raw: "small tail content", content: "small tail content", frontmatter: null };
      }
      return { path, raw: big, content: big, frontmatter: null };
    });
    complete.mockResolvedValue("- bullet");

    await runSessionDigest("/v");

    const prompt = complete.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain("1 more session logs omitted for length");
    expect(prompt).not.toContain("small tail content");
  });

  it("appends under a sub-line instead of duplicating the header when one already exists for that day", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"] },
    ]);
    mockReadFile("# 2026-08-10\n\n## Session digest (auto)\n_from 2 session logs — low confidence_\n- Earlier bullet\n");
    complete.mockResolvedValue("- New bullet");

    await runSessionDigest("/v");

    const content = writeFile.mock.calls[0][1] as string;
    expect(content.match(/## Session digest \(auto\)/g)).toHaveLength(1);
    expect(content).toContain("_run of ");
    expect(content).toContain("New bullet");
    expect(content).toContain("Earlier bullet");
    // Important 4: the daily file already existed — nothing new to record.
    expect(appendDistillManifest).not.toHaveBeenCalled();
  });

  it("records every session file stem of the digest in the same write, and only the new ones on a late-arrival re-run", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      {
        day: "2026-08-10",
        files: ["sessions/2026-08/claude-code-aaa.md", "sessions/2026-08/codex-bbb.md"],
        already_digested: false,
      },
    ]);
    mockReadFile();
    complete.mockResolvedValue("- bullet");

    await runSessionDigest("/v");

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][1]).toContain(
      "<!-- myco:digested-sessions claude-code-aaa codex-bbb -->",
    );

    // A session that lands on that day later is new knowledge: Rust hands
    // back only the un-recorded file, so the new section records only it.
    writeFile.mockClear();
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08/codex-ccc.md"], already_digested: false },
    ]);
    mockReadFile("# 2026-08-10\n\n## Session digest (auto)\n<!-- myco:digested-sessions claude-code-aaa codex-bbb -->\n- bullet\n");

    await runSessionDigest("/v");

    const second = writeFile.mock.calls[0][1] as string;
    expect(second).toContain("<!-- myco:digested-sessions codex-ccc -->");
    expect(second.match(/myco:digested-sessions/g)).toHaveLength(2);
  });

  it("does not archive a day whose complete() call rejects, and stops there", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue({ ...CFG, llm_digest_days: 2 });
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"] },
      { day: "2026-08-11", files: ["sessions/2026-08-11/b.md"] },
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
