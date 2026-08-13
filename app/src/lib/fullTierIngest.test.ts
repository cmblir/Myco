import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DistillConfig } from "./distill";

const getActiveModel = vi.fn();
vi.mock("./chat", () => ({
  getActiveModel: (...a: unknown[]) => getActiveModel(...a),
}));

const runIngestProvider = vi.fn();
vi.mock("../stores/ingestStore", () => ({
  // Mirrors the real signature's 5th param so tests can see whether the
  // profile-interests grounding line reached the prompt, without pulling in
  // the real INGEST_PROMPT template.
  INGEST_PROMPT: (slug: string, title: string, _c?: unknown, _p?: unknown, interests = "") =>
    `prompt for ${slug} (${title})${interests ? ` | interests: ${interests}` : ""}`,
  runIngestProvider: (...a: unknown[]) => runIngestProvider(...a),
}));

const getSettings = vi.fn();
const getDistillConfig = vi.fn();
const fullTierItems = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const availableRawPath = vi.fn();
const archiveInboxSource = vi.fn();
const claudeRun = vi.fn();
const appendDistillManifest = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    getSettings: (...a: unknown[]) => getSettings(...a),
    getDistillConfig: (...a: unknown[]) => getDistillConfig(...a),
    fullTierItems: (...a: unknown[]) => fullTierItems(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    availableRawPath: (...a: unknown[]) => availableRawPath(...a),
    archiveInboxSource: (...a: unknown[]) => archiveInboxSource(...a),
    claudeRun: (...a: unknown[]) => claudeRun(...a),
    appendDistillManifest: (...a: unknown[]) => appendDistillManifest(...a),
  },
}));

import { runFullTierIngest } from "./fullTierIngest";

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
  llm_digest_days: 3,
  llm_ingest_budget: 3,
  profile_injection: true,
};

beforeEach(() => {
  getActiveModel.mockReset();
  runIngestProvider.mockReset();
  getSettings.mockReset();
  getDistillConfig.mockReset();
  fullTierItems.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  availableRawPath.mockReset();
  archiveInboxSource.mockReset();
  claudeRun.mockReset();
  appendDistillManifest.mockReset();

  getActiveModel.mockResolvedValue({ provider: "anthropic-api", model: "" });
  getDistillConfig.mockResolvedValue(CFG);
  readFile.mockResolvedValue({ raw: "# A title\n\nbody", content: "body", frontmatter: null, path: "" });
  runIngestProvider.mockResolvedValue("ok");
  archiveInboxSource.mockResolvedValue("");
  appendDistillManifest.mockResolvedValue(null);
});

describe("runFullTierIngest", () => {
  it("skips with no-provider when the active ingest model is builtin-local, and never lists items", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "" });

    const result = await runFullTierIngest("/v");

    expect(result).toEqual({ ingested: 0, skipped: "no-provider", errors: [] });
    expect(fullTierItems).not.toHaveBeenCalled();
  });

  it("skips with no-provider when myco-pro is selected but not connected", async () => {
    getActiveModel.mockResolvedValue({ provider: "myco-pro", model: "" });
    getSettings.mockResolvedValue({ providers: { myco_pro: false } });

    const result = await runFullTierIngest("/v");

    expect(result).toEqual({ ingested: 0, skipped: "no-provider", errors: [] });
    expect(fullTierItems).not.toHaveBeenCalled();
  });

  it("skips with nothing when there are no full-tier items", async () => {
    fullTierItems.mockResolvedValue([]);

    const result = await runFullTierIngest("/v");

    expect(result).toEqual({ ingested: 0, skipped: "nothing", errors: [] });
    expect(runIngestProvider).not.toHaveBeenCalled();
  });

  it("respects the budget: 5 items, budget 3 -> 3 runIngestProvider calls", async () => {
    fullTierItems.mockResolvedValue([
      "raw/a.md",
      "raw/b.md",
      "raw/c.md",
      "raw/d.md",
      "raw/e.md",
    ]);

    const result = await runFullTierIngest("/v");

    expect(runIngestProvider).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ingested: 3, skipped: null, errors: [] });
  });

  it("one item throwing collects an error and continues to the next", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md", "raw/b.md", "raw/c.md"]);
    runIngestProvider
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce(new Error("provider boom"))
      .mockResolvedValueOnce("ok");

    const result = await runFullTierIngest("/v");

    expect(result.ingested).toBe(2);
    expect(result.errors).toEqual(["raw/b.md: Error: provider boom"]);
    expect(runIngestProvider).toHaveBeenCalledTimes(3);
  });

  it("promotes an _inbox/ item to raw/ before ingesting, then archives the original", async () => {
    fullTierItems.mockResolvedValue(["_inbox/clip.md"]);
    availableRawPath.mockResolvedValue("raw/clip.md");
    archiveInboxSource.mockResolvedValue("/v/_inbox/.archived/clip.md");
    readFile.mockResolvedValue({ raw: "# Clipped\n\nbody", content: "body", frontmatter: null, path: "" });

    const result = await runFullTierIngest("/v");

    expect(availableRawPath).toHaveBeenCalledWith("clip");
    expect(writeFile).toHaveBeenCalledWith("/v/raw/clip.md", "# Clipped\n\nbody");
    expect(archiveInboxSource).toHaveBeenCalledWith("/v/_inbox/clip.md");
    expect(runIngestProvider).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "clip", title: "Clipped" }),
    );
    expect(result).toEqual({ ingested: 1, skipped: null, errors: [] });
    // Important 4 (Phase B whole-branch review): the _inbox/ archive-move +
    // raw/ create land in one "llm-<ts>" manifest for this run.
    expect(appendDistillManifest).toHaveBeenCalledWith(
      "/v",
      expect.stringMatching(/^llm-\d+$/),
      [{ from: "_inbox/clip.md", to: "_inbox/.archived/clip.md" }],
      ["raw/clip.md"],
    );
  });

  it("archives before promoting: an archiveInboxSource failure writes no raw copy and collects an error", async () => {
    fullTierItems.mockResolvedValue(["_inbox/clip.md"]);
    archiveInboxSource.mockRejectedValue(new Error("locked"));

    const result = await runFullTierIngest("/v");

    expect(archiveInboxSource).toHaveBeenCalledWith("/v/_inbox/clip.md");
    expect(availableRawPath).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(result).toEqual({
      ingested: 0,
      skipped: null,
      errors: ["_inbox/clip.md: Error: locked"],
    });
  });

  it("collects an error with no rollback attempt when writeFile fails after a successful archive", async () => {
    fullTierItems.mockResolvedValue(["_inbox/clip.md"]);
    availableRawPath.mockResolvedValue("raw/clip.md");
    writeFile.mockRejectedValue(new Error("disk full"));

    const result = await runFullTierIngest("/v");

    // The original is already safely archived by the time writeFile fails —
    // there is nothing to roll back (see fullTierIngest.ts's doc comment).
    expect(archiveInboxSource).toHaveBeenCalledWith("/v/_inbox/clip.md");
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(result).toEqual({
      ingested: 0,
      skipped: null,
      errors: ["_inbox/clip.md: Error: disk full"],
    });
  });

  it("uses the file stem as the title when there is no ATX heading", async () => {
    fullTierItems.mockResolvedValue(["raw/no-heading.md"]);
    readFile.mockResolvedValue({ raw: "just a paragraph, no heading", content: "", frontmatter: null, path: "" });

    await runFullTierIngest("/v");

    expect(runIngestProvider).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "no-heading", title: "no-heading" }),
    );
  });

  it("strips a leading frontmatter block before searching for the title heading", async () => {
    fullTierItems.mockResolvedValue(["raw/frontmattered.md"]);
    readFile.mockResolvedValue({
      raw: "---\n# not a title, a YAML comment\ntitle: ignored\n---\n\n# Real Title\n\nbody",
      content: "",
      frontmatter: null,
      path: "",
    });

    await runFullTierIngest("/v");

    expect(runIngestProvider).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "frontmattered", title: "Real Title" }),
    );
  });

  it("uses ipc.claudeRun directly (not runIngestProvider) for the anthropic-cli provider", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    fullTierItems.mockResolvedValue(["raw/a.md"]);
    claudeRun.mockResolvedValue({ stdout: "done", stderr: "", status: 0 });

    const result = await runFullTierIngest("/v");

    expect(claudeRun).toHaveBeenCalledWith(expect.any(String), "/v", "sonnet");
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(result).toEqual({ ingested: 1, skipped: null, errors: [] });
  });

  it("collects an error when the anthropic-cli claudeRun exits non-zero", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    fullTierItems.mockResolvedValue(["raw/a.md"]);
    claudeRun.mockResolvedValue({ stdout: "", stderr: "boom", status: 1 });

    const result = await runFullTierIngest("/v");

    expect(result.ingested).toBe(0);
    expect(result.errors).toEqual(["raw/a.md: Error: boom"]);
  });
});

// Phase B, Task 6 (review-adjudicated): the interests grounding line is
// governed by the same profile_injection toggle as chat.ts's full profile
// paragraph — this is still profile content sent to the configured provider,
// so "a profile exists" alone is not enough. Fail CLOSED when the toggle
// can't be confirmed.
describe("runFullTierIngest profile interests grounding", () => {
  const PROFILE_MD = "## Role\nBackend engineer\n\n## Interests\n- rust\n- vector search\n";

  it("includes the interests line when the toggle is on and a profile exists", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md"]);
    readFile.mockResolvedValue({ raw: PROFILE_MD, content: "", frontmatter: null, path: "" });
    // getDistillConfig default (beforeEach) already resolves CFG with profile_injection: true.

    await runFullTierIngest("/v");

    const call = runIngestProvider.mock.calls[0][0];
    expect(call.prompt).toContain("interests: rust, vector search");
  });

  it("omits the interests line when the toggle is off, even with a profile present", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md"]);
    getDistillConfig.mockResolvedValue({ ...CFG, profile_injection: false });
    readFile.mockResolvedValue({ raw: PROFILE_MD, content: "", frontmatter: null, path: "" });

    await runFullTierIngest("/v");

    const call = runIngestProvider.mock.calls[0][0];
    expect(call.prompt).not.toContain("interests");
  });

  it("fails closed (omits the interests line) when the distill config can't be read", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md"]);
    getDistillConfig.mockRejectedValue(new Error("io error"));
    readFile.mockResolvedValue({ raw: PROFILE_MD, content: "", frontmatter: null, path: "" });

    await runFullTierIngest("/v");

    const call = runIngestProvider.mock.calls[0][0];
    expect(call.prompt).not.toContain("interests");
  });
});
