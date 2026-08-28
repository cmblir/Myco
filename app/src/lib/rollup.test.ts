// Mirrors sessionDigest.test.ts one compression layer up: week eligibility is
// Rust's job (distill.rs's own suite), so what is asserted here is the TS
// half — marker idempotency, the extractive path, the manifest/undo hookup,
// the per-run cap, and that a failure never archives.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DistillConfig } from "./distill";

const complete = vi.fn();
const getActiveModel = vi.fn();
vi.mock("./chat", () => ({
  complete: (...a: unknown[]) => complete(...a),
  getActiveModel: (...a: unknown[]) => getActiveModel(...a),
}));

const getDistillConfig = vi.fn();
const rollupableBuckets = vi.fn();
const archiveRolled = vi.fn();
const appendDistillManifest = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const createFolder = vi.fn();
const embedLocalTexts = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    getDistillConfig: (...a: unknown[]) => getDistillConfig(...a),
    rollupableBuckets: (...a: unknown[]) => rollupableBuckets(...a),
    archiveRolled: (...a: unknown[]) => archiveRolled(...a),
    appendDistillManifest: (...a: unknown[]) => appendDistillManifest(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    createFolder: (...a: unknown[]) => createFolder(...a),
    embedLocalTexts: (...a: unknown[]) => embedLocalTexts(...a),
  },
}));

import { MONTHLY_SYSTEM, runMonthlyRollup, runWeeklyRollup, ROLLUP_SYSTEM } from "./rollup";
import { fingerprint } from "./sessionDigest";

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

// A daily digest as the session-digest step actually writes it: a title, a
// section header, a label line, a marker, and bullets long enough to clear
// the extractive path's MIN_UNIT_CHARS.
const DAILY_RAW = [
  "# 2026-08-10",
  "",
  "## Session digest (auto)",
  "_from 3 session logs — low confidence_",
  "<!-- myco:digested-sessions claude-code-abc:1a2b3c4d -->",
  "- bound the digest marker to content fingerprints so a resumed conversation misses its old record",
  "- shipped the archive retry path: only the file move is retried, never the paid call",
  "- ok",
  "",
].join("\n");

function mockReadDaily(weeklyExisting: string | null = null): void {
  readFile.mockImplementation(async (path: string) => {
    if (path.includes("/weekly/")) {
      if (weeklyExisting !== null) {
        return { path, raw: weeklyExisting, content: weeklyExisting, frontmatter: null };
      }
      throw new Error("not found");
    }
    return { path, raw: DAILY_RAW, content: DAILY_RAW, frontmatter: null };
  });
}

// Deterministic stand-in for the local embedder — same shape as
// sessionDigest.test.ts's.
function mockEmbeddings(texts: string[]): number[][] {
  return texts.map((t) => {
    const v = new Array(8).fill(0);
    for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) % 32;
    return v;
  });
}

beforeEach(() => {
  complete.mockReset();
  getActiveModel.mockReset();
  getDistillConfig.mockReset();
  rollupableBuckets.mockReset();
  archiveRolled.mockReset();
  appendDistillManifest.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  createFolder.mockReset();
  embedLocalTexts.mockReset();
  embedLocalTexts.mockImplementation(async (texts: string[]) => mockEmbeddings(texts));
  createFolder.mockResolvedValue("weekly");
  writeFile.mockResolvedValue(null);
  archiveRolled.mockResolvedValue("digest-archived");
  appendDistillManifest.mockResolvedValue(null);
});

describe("ROLLUP_SYSTEM", () => {
  it("instructs bullets-only compression with an uncertainty marker", () => {
    expect(ROLLUP_SYSTEM).toContain("(uncertain)");
  });
});

describe("runWeeklyRollup", () => {
  it("skips with nothing when no week is settled", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([]);

    const result = await runWeeklyRollup("/v");

    expect(result).toEqual({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "llm" });
    expect(complete).not.toHaveBeenCalled();
    expect(archiveRolled).not.toHaveBeenCalled();
  });

  it("rolls up only the first llm_digest_days weeks, one call each, and writes the marker in the same write", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG); // llm_digest_days: 1
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md", "daily/2026-08-11.md"] },
      { bucket: "2026-W34", files: ["daily/2026-08-17.md"] },
    ]);
    mockReadDaily();
    complete.mockResolvedValue("- Week's decision: fingerprint the marker");

    const result = await runWeeklyRollup("/v");

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toMatchObject({ task: "generate", cwd: "/v" });
    expect(complete.mock.calls[0][0].messages[0]).toEqual({
      role: "system",
      content: ROLLUP_SYSTEM,
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0];
    expect(path).toBe("/v/weekly/2026-W33.md");
    expect(content).toContain("## Weekly rollup");
    expect(content).toContain("_from 2 daily digests — low confidence_");
    expect(content).toContain("Week's decision");
    const fp = fingerprint(DAILY_RAW);
    expect(content).toContain(`<!-- myco:rolled-up-days 2026-08-10:${fp} 2026-08-11:${fp} -->`);
    // Same fingerprints handed to the archive, so a daily note appended to
    // between the read and the move stays put.
    expect(archiveRolled).toHaveBeenCalledTimes(1);
    expect(archiveRolled).toHaveBeenCalledWith(
      "/v",
      "weekly",
      "2026-W33",
      ["daily/2026-08-10.md", "daily/2026-08-11.md"],
      [fp, fp],
    );
    // The weekly file was created fresh, so its create folds into the archive
    // step's OWN manifest id — one undo entry per run, same as the digest.
    expect(appendDistillManifest).toHaveBeenCalledWith(
      "/v",
      "digest-archived",
      [],
      ["weekly/2026-W33.md"],
    );
    expect(embedLocalTexts).not.toHaveBeenCalled();
    expect(result).toEqual({ bucketsRolledUp: 1, sourcesArchived: 2, skipped: null, mode: "llm" });
  });

  it("does not re-roll an already-recorded week — only the archive is retried", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md"], already_rolled: true },
    ]);

    const result = await runWeeklyRollup("/v");

    expect(complete).not.toHaveBeenCalled();
    expect(embedLocalTexts).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    // No fingerprints on the retry path — the marker an earlier run wrote is
    // the record Rust re-checks against.
    expect(archiveRolled).toHaveBeenCalledWith("/v", "weekly", "2026-W33", ["daily/2026-08-10.md"], null);
    expect(result).toEqual({ bucketsRolledUp: 1, sourcesArchived: 1, skipped: null, mode: "llm" });
  });

  it("rolls up extractively on builtin-local: quoted bullets attributed to the day, no LLM call", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "bge-m3" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md"] },
    ]);
    mockReadDaily();

    const result = await runWeeklyRollup("/v");

    expect(complete).not.toHaveBeenCalled();
    expect(embedLocalTexts).toHaveBeenCalledTimes(1);
    // The units are the daily file's BULLETS — not its headings, its label
    // line, its marker, or its one-word bullet.
    const units = embedLocalTexts.mock.calls[0][0] as string[];
    expect(units.some((u) => u.includes("bound the digest marker"))).toBe(true);
    expect(units.some((u) => u.startsWith("<!--"))).toBe(false);
    expect(units.some((u) => u.startsWith("#"))).toBe(false);
    expect(units).not.toContain("ok");
    const content = writeFile.mock.calls[0][1] as string;
    expect(content).toContain("## Weekly rollup");
    expect(content).toContain("extractive quotes (no LLM)");
    // The day is named once as a group header, not suffixed onto each bullet.
    expect(content).toMatch(/\*\*2026-08-10\*\*\n- ".+"/);
    expect(content.match(/\*\*2026-08-10\*\*/g)).toHaveLength(1);
    expect(content).toContain(`<!-- myco:rolled-up-days 2026-08-10:${fingerprint(DAILY_RAW)} -->`);
    expect(result).toEqual({
      bucketsRolledUp: 1,
      sourcesArchived: 1,
      skipped: null,
      mode: "extractive",
    });
  });

  it("produces byte-identical extractive output for the same inputs", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "bge-m3" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md"] },
    ]);
    mockReadDaily();

    await runWeeklyRollup("/v");
    const first = writeFile.mock.calls[0][1] as string;
    writeFile.mockClear();
    await runWeeklyRollup("/v");

    expect(writeFile.mock.calls[0][1]).toBe(first);
  });

  it("quotes a bullet-free hand-written daily note by paragraph instead of dropping it", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "bge-m3" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md"] },
    ]);
    const prose = "spent the day reasoning about why the archive retry loops, and wrote it down here";
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/weekly/")) throw new Error("not found");
      return { path, raw: prose, content: prose, frontmatter: null };
    });

    await runWeeklyRollup("/v");

    expect(embedLocalTexts.mock.calls[0][0]).toEqual([prose]);
    expect(writeFile.mock.calls[0][1]).toContain(prose);
  });

  it("appends under a sub-line instead of duplicating the header, and records nothing new for undo", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-12.md"] },
    ]);
    mockReadDaily(
      "# 2026-W33\n\n## Weekly rollup\n_from 2 daily digests — low confidence_\n- Earlier bullet\n",
    );
    complete.mockResolvedValue("- New bullet");

    await runWeeklyRollup("/v");

    const content = writeFile.mock.calls[0][1] as string;
    expect(content.match(/## Weekly rollup/g)).toHaveLength(1);
    expect(content).toContain("_run of ");
    expect(content).toContain("Earlier bullet");
    expect(content).toContain("New bullet");
    // The weekly file already existed — undo must not delete the whole thing.
    expect(appendDistillManifest).not.toHaveBeenCalled();
  });

  it("marks daily files dropped by the prompt budget", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      {
        bucket: "2026-W33",
        files: ["daily/2026-08-10.md", "daily/2026-08-11.md", "daily/2026-08-12.md"],
      },
    ]);
    const big = "x".repeat(30_000); // two saturate the 40k pool
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/weekly/")) throw new Error("not found");
      if (path.endsWith("2026-08-12.md")) {
        return { path, raw: "small tail content", content: "small tail content", frontmatter: null };
      }
      return { path, raw: big, content: big, frontmatter: null };
    });
    complete.mockResolvedValue("- bullet");

    await runWeeklyRollup("/v");

    const prompt = complete.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain("1 more daily digests omitted for length");
    expect(prompt).not.toContain("small tail content");
  });

  it("does not archive a week whose provider call rejects, and stops there", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue({ ...CFG, llm_digest_days: 2 });
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md"] },
      { bucket: "2026-W34", files: ["daily/2026-08-17.md"] },
    ]);
    mockReadDaily();
    complete.mockRejectedValue(new Error("provider boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runWeeklyRollup("/v");

    expect(archiveRolled).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(result).toEqual({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: null, mode: "llm" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("treats an existing-but-blank weekly file as missing: seeds the title and records the manifest", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md"] },
    ]);
    mockReadDaily("");
    complete.mockResolvedValue("- New bullet");

    await runWeeklyRollup("/v");

    const content = writeFile.mock.calls[0][1] as string;
    expect(content.startsWith("# 2026-W33\n")).toBe(true);
    expect(appendDistillManifest).toHaveBeenCalledWith(
      "/v",
      "digest-archived",
      [],
      ["weekly/2026-W33.md"],
    );
  });
});

describe("runMonthlyRollup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    archiveRolled.mockResolvedValue("digest-archived");
    appendDistillManifest.mockResolvedValue(null);
    writeFile.mockResolvedValue(null);
    createFolder.mockResolvedValue(null);
  });

  it("rolls weekly/ into monthly/<YYYY-MM>.md and archives the weeks it covered", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-07", files: ["weekly/2026-W27.md", "weekly/2026-W28.md"] },
    ]);
    const WEEKLY_RAW = [
      "# 2026-W27",
      "",
      "## Weekly rollup",
      "_from 5 daily digests — low confidence_",
      "- Decided the rollup marker binds to content, not to the file name.",
    ].join("\n");
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/monthly/")) throw new Error("not found");
      return { raw: WEEKLY_RAW };
    });
    complete.mockResolvedValue("- The month's decision");

    const result = await runMonthlyRollup("/v");

    // The layer name travels on every IPC call — Rust picks the source tree
    // (`weekly/`) and the archive bucket shape from it.
    expect(rollupableBuckets).toHaveBeenCalledWith("/v", "monthly");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: MONTHLY_SYSTEM },
          expect.objectContaining({ role: "user" }),
        ],
      }),
    );

    const [path, content] = writeFile.mock.calls[0] as [string, string];
    expect(path).toBe("/v/monthly/2026-07.md");
    expect(content).toContain("## Monthly rollup");
    expect(content).toContain("_from 2 weekly rollups — low confidence_");
    // Same marker literal as the layer below, over weekly stems — one
    // `marker_entries` implementation serves both tiers.
    const fp = fingerprint(WEEKLY_RAW);
    expect(content).toContain(`<!-- myco:rolled-up-days 2026-W27:${fp} 2026-W28:${fp} -->`);

    expect(archiveRolled).toHaveBeenCalledWith(
      "/v",
      "monthly",
      "2026-07",
      ["weekly/2026-W27.md", "weekly/2026-W28.md"],
      [fp, fp],
    );
    expect(appendDistillManifest).toHaveBeenCalledWith(
      "/v",
      "digest-archived",
      [],
      ["monthly/2026-07.md"],
    );
    expect(result).toEqual({
      bucketsRolledUp: 1,
      sourcesArchived: 2,
      skipped: null,
      mode: "llm",
    });
  });

  it("never archives a month whose rollup call failed", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-07", files: ["weekly/2026-W27.md"] },
    ]);
    readFile.mockResolvedValue({ raw: "# w\n- something worth quoting in a rollup" });
    complete.mockRejectedValue(new Error("provider down"));

    const result = await runMonthlyRollup("/v");

    expect(archiveRolled).not.toHaveBeenCalled();
    expect(result).toEqual({
      bucketsRolledUp: 0,
      sourcesArchived: 0,
      skipped: null,
      mode: "llm",
    });
  });
});
