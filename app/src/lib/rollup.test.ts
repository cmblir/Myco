// Mirrors sessionDigest.test.ts one compression layer up: week eligibility is
// Rust's job (distill.rs's own suite), so what is asserted here is the TS
// half — marker idempotency, the extractive path, the manifest/undo hookup,
// the per-run cap, and that a failure never archives.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DistillConfig } from "./distill";
import type { AgentVaultSession, ArchiveOptions, ArchiveReceipt } from "./ipc";
import type { RoleId, RoleUsage } from "./modelRoles";
import { roleFixture, selectedRolesFixture } from "./modelRoles.testSupport";
import { evidenceCoverage, evidenceSection, sourceEvidence } from "./sessionEvidence";
import { sha256 } from "./tidyRun";
import { BUILTIN_CHAT_MODEL, BUILTIN_FAST_CHAT_MODEL } from "./providers";


const ORIGIN = { vaultPath: "/v", openingToken: "synthetic-opening" };
// Synthetic IPC receipts exercise frontend accounting, not native IO proof.
function archiveSuccess(paths: string[], options: ArchiveOptions): ArchiveReceipt {
  return { manifestId: options.manifestId,
    moved: paths.map(from => ({ from, to: `archive/${from}`, revision: "a".repeat(64) })),
    pending: [], skipped: [], createdNotePaths: options.publications.filter(p => p.created).map(p => p.path), retryable: true };
}
const complete = vi.fn();
const captureModelRole = vi.fn();
let organizationChoice = { providerId: "builtin-local", modelId: "extractive-ingest" };
function selectOrganization(choice: { provider: string; model: string }): void {
  organizationChoice = { providerId: choice.provider, modelId: choice.model };
  getSettings.mockResolvedValue({ model_roles: selectedRolesFixture({ organization: organizationChoice }) });
}
vi.mock("./chat", () => ({
  complete: (...a: unknown[]) => complete(...a),
}));
vi.mock("../stores/uiStore", () => ({ useUIStore: { getState: () => ({ lang: "en" }) } }));

const getDistillConfig = vi.fn();
const getSettings = vi.fn();
const rollupableBuckets = vi.fn();
const archiveRolled = vi.fn();
const appendDistillManifest = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const writeFileIfUnchanged = vi.fn();
const publishDistillNote = vi.fn();
let openingSequence = 0;
const createFolder = vi.fn();
const embedLocalTexts = vi.fn();
const localTransform = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    agentVaultSession: async () => ORIGIN,
    captureModelRole: (...a: unknown[]) => captureModelRole(...a),
    getDistillConfig: (...a: unknown[]) => getDistillConfig(...a),
    getSettings: (...a: unknown[]) => getSettings(...a),
    rollupableBuckets: (...a: unknown[]) => rollupableBuckets(...a),
    archiveRolled: (...a: unknown[]) => archiveRolled(...a),
    appendDistillManifest: (...a: unknown[]) => appendDistillManifest(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    writeFileIfUnchanged: (...a: unknown[]) => writeFileIfUnchanged(...a),
    publishDistillNote: (...a: unknown[]) => publishDistillNote(...a),
    createFolder: (...a: unknown[]) => createFolder(...a),
    embedLocalTexts: (...a: unknown[]) => embedLocalTexts(...a),
    localTransform: (...a: unknown[]) => localTransform(...a),
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

function mockReadDaily(weeklyExisting: string | null = null, raw = DAILY_RAW): void {
  readFile.mockImplementation(async (path: string) => {
    if (path.includes("/weekly/")) {
      if (weeklyExisting !== null) {
        return { path, raw: weeklyExisting, content: weeklyExisting, frontmatter: null };
      }
      throw new Error("ENOENT: no such file or directory");
    }
    return { path, raw, content: raw, frontmatter: null };
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
  ORIGIN.openingToken = `synthetic-opening-${++openingSequence}`;
  complete.mockReset();
  captureModelRole.mockReset().mockImplementation(async (origin: AgentVaultSession, role: RoleId, usage: RoleUsage) => {
    expect(origin).toEqual(ORIGIN);
    expect(role).toBe("organization");
    return roleFixture(role, organizationChoice.providerId, organizationChoice.modelId, origin, usage);
  });
  getDistillConfig.mockReset();
  getSettings.mockReset();
  selectOrganization({ provider: "builtin-local", model: "extractive-ingest" });
  rollupableBuckets.mockReset();
  archiveRolled.mockReset();
  appendDistillManifest.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  writeFileIfUnchanged.mockReset();
  publishDistillNote.mockReset().mockImplementation(async (_origin, operationId: string, artifact: { kind: string; key: string }, content: string, expected: string | null) => {
    const path = `${artifact.kind}/${artifact.key}.md`;
    // Synthetic native stand-in retains the existing CAS race fixtures.
    await writeFileIfUnchanged(`/v/${path}`, content, expected);
    return { publicationId: "b".repeat(64), operationId, path, revision: await sha256(content), nativeCreated: expected === null, state: "published",
      fileIdentity: { device: 1, inode: 2, changedSeconds: 3, changedNanoseconds: 4 } };
  });
  createFolder.mockReset();
  embedLocalTexts.mockReset();
  localTransform.mockReset();
  embedLocalTexts.mockImplementation(async (texts: string[]) => mockEmbeddings(texts));
  createFolder.mockResolvedValue("weekly");
  writeFile.mockResolvedValue(null);
  writeFileIfUnchanged.mockImplementation(async (path: string, content: string, expected: string | null) => {
    let current: string | null;
    try { current = (await readFile(path)).raw; }
    catch (error) {
      if (!String(error).includes("ENOENT")) throw error;
      current = null;
    }
    if ((current === null ? null : await sha256(current)) !== expected) throw "write conflict: changed";
    await writeFile(path, content);
  });
  archiveRolled.mockImplementation(async (_vault: string, _layer: string, _bucket: string, paths: string[], _fingerprints: string[], options: ArchiveOptions) => archiveSuccess(paths, options));
  appendDistillManifest.mockResolvedValue(null);
});

describe("ROLLUP_SYSTEM", () => {
  it("instructs bullets-only compression with an uncertainty marker", () => {
    expect(ROLLUP_SYSTEM).toContain("(uncertain)");
  });
});

describe("runWeeklyRollup", () => {
  it("counts actual native moves and preserves declined daily sources as pending", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([{ bucket: "2026-W33", files: ["daily/2026-08-10.md"] }]);
    mockReadDaily();
    complete.mockResolvedValue("- Synthetic source-backed preview");
    archiveRolled.mockResolvedValue({ manifestId: "llm-1", moved: [],
      pending: [{ path: "daily/2026-08-10.md", reason: "synthetic fingerprint changed" }],
      skipped: [], createdNotePaths: ["weekly/2026-W33.md"], retryable: true });
    const result = await runWeeklyRollup("/v");
    expect(result).toMatchObject({ sourcesArchived: 0, sourcesPending: 1, status: "partial" });
    expect(result.issues?.[0].error).toContain("synthetic fingerprint changed");
  });
  it("skips with nothing when no week is settled", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([]);

    const result = await runWeeklyRollup("/v");

    expect(result).toEqual({ bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode: "llm" });
    expect(complete).not.toHaveBeenCalled();
    expect(archiveRolled).not.toHaveBeenCalled();
  });

  it("rolls up only the first llm_digest_days weeks, one call each, and writes the marker in the same write", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
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
      [fp, fp], expect.objectContaining({ origin: ORIGIN, manifestId: expect.stringMatching(/^llm-\d+$/), publications: expect.any(Array) }));
    // The weekly file was created fresh, so its create folds into the archive
    // step's OWN manifest id — one undo entry per run, same as the digest.
    expect(archiveRolled.mock.calls[0][5].publications).toEqual([{ path: "weekly/2026-W33.md", revision: await sha256(writeFile.mock.calls[0][1]), created: true }]);
    expect(appendDistillManifest).not.toHaveBeenCalled();
    expect(embedLocalTexts).not.toHaveBeenCalled();
    expect(result).toEqual({ bucketsRolledUp: 1, sourcesArchived: 2, skipped: null, mode: "llm", chunksProcessed: 2 });
  });

  it("retains a legacy covered week without inferring creation authority", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md"], already_rolled: true },
    ]);
    const source = sourceEvidence("daily/2026-08-10.md", DAILY_RAW, "2026-W33");
    mockReadDaily("# 2026-W33\n" + evidenceSection([source], source.chunks));

    const result = await runWeeklyRollup("/v");

    expect(complete).not.toHaveBeenCalled();
    expect(embedLocalTexts).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith("/v/daily/2026-08-10.md");
    expect(writeFile).not.toHaveBeenCalled();
    expect(archiveRolled).not.toHaveBeenCalled();
    expect(publishDistillNote).not.toHaveBeenCalled();
    expect(result).toMatchObject({ bucketsRolledUp: 0, sourcesArchived: 0, sourcesPending: 1, status: "pending", mode: "llm" });
    expect(result.issues?.[0].error).toContain("manual recovery");
  });

  it("rolls up extractively on builtin-local: quoted bullets attributed to the day, no LLM call", async () => {
    selectOrganization({ provider: "builtin-local", model: "extractive-ingest" });
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
    // Semantic headings survive because they may contain the only topic name.
    expect(units.some((u) => u.includes("2026-08-10"))).toBe(true);
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
      chunksProcessed: 1,
    });
  });

  it("produces byte-identical extractive output for the same inputs", async () => {
    selectOrganization({ provider: "builtin-local", model: "extractive-ingest" });
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
    selectOrganization({ provider: "builtin-local", model: "extractive-ingest" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md"] },
    ]);
    const prose = "spent the day reasoning about why the archive retry loops, and wrote it down here";
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/weekly/")) throw new Error("ENOENT: no such file or directory");
      return { path, raw: prose, content: prose, frontmatter: null };
    });

    await runWeeklyRollup("/v");

    expect(embedLocalTexts.mock.calls[0][0]).toEqual([prose]);
    expect(writeFile.mock.calls[0][1]).toContain(prose);
  });

  it("appends under a sub-line instead of duplicating the header, and records nothing new for undo", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
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

  it("resumes long coverage and retains sources after an existing output update", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    const active = new Map([
      ["daily/2026-08-10.md", "x".repeat(30_000)],
      ["daily/2026-08-11.md", "y".repeat(30_000)],
      ["daily/2026-08-12.md", "Changed the earlier decision: ORION is cancelled."],
    ]);
    const notes = new Map<string, string>();
    rollupableBuckets.mockImplementation(async () => [{ bucket: "2026-W33", files: [...active.keys()] }]);
    readFile.mockImplementation(async (path: string) => {
      const raw = notes.get(path) ?? active.get(path.replace("/v/", ""));
      if (raw === undefined) throw new Error("ENOENT: no such file or directory");
      return { raw };
    });
    writeFile.mockImplementation(async (path: string, raw: string) => { notes.set(path, raw); });
    archiveRolled.mockImplementation(async (_vault: string, _layer: string, _bucket: string, paths: string[], _fingerprints: string[], options: ArchiveOptions) => {
      paths.forEach(path => active.delete(path));
      return archiveSuccess(paths, options);
    });
    complete.mockResolvedValue("- bounded preview");
    const first = await runWeeklyRollup("/v");
    expect(first).toMatchObject({ sourcesArchived: 0, sourcesPending: 3, chunksProcessed: 48 });
    expect(archiveRolled.mock.calls[0][3]).toEqual([]);
    expect(complete.mock.calls[0][0].messages[1].content.length).toBeLessThan(40_000);
    await runWeeklyRollup("/v");
    expect(active.has("daily/2026-08-11.md")).toBe(true);
    const last = await runWeeklyRollup("/v");
    expect(active.size).toBe(3);
    expect(last).toMatchObject({ sourcesArchived: 0, sourcesPending: 3, status: "partial" });
    expect(last.issues?.[0].error).toContain("manual recovery");
    expect(archiveRolled).toHaveBeenCalledTimes(1);
    expect(notes.get("/v/weekly/2026-W33.md")).toContain("ORION is cancelled");
    expect(notes.get("/v/weekly/2026-W33.md")).toContain("[[daily/2026-08-12.md]]");
  });

  it("keeps all remaining historical inputs active when the selected provider fails", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
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
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ bucketsRolledUp: 0, sourcesArchived: 0, sourcesPending: 2, status: "failed" });
    expect(result.issues?.[0].error).toContain("provider boom");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("seeds an existing blank weekly file without claiming native creation", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md"] },
    ]);
    mockReadDaily("");
    complete.mockResolvedValue("- New bullet");

    await runWeeklyRollup("/v");

    const content = writeFile.mock.calls[0][1] as string;
    expect(content.startsWith("# 2026-W33\n")).toBe(true);
    expect(publishDistillNote.mock.calls[0][4]).toBe(await sha256(""));
    expect(archiveRolled).not.toHaveBeenCalled();
    expect(appendDistillManifest).not.toHaveBeenCalled();
  });
});

describe("runWeeklyRollup with a selected local organizer", () => {
  const exactRaw = DAILY_RAW.replace(/^<!-- myco:digested-sessions .* -->\n/m, "");
  beforeEach(() => {
    selectOrganization({ provider: "builtin-local", model: BUILTIN_CHAT_MODEL });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: ["daily/2026-08-10.md"] },
    ]);
  });

  it("uses the explicitly selected Organization generator independently of quote-only Ask", async () => {
    selectOrganization({ provider: "builtin-local", model: BUILTIN_FAST_CHAT_MODEL });
    getSettings.mockResolvedValue({ model_roles: selectedRolesFixture({
      ask: { providerId: "builtin-local", modelId: "extractive-retrieval" },
      compilation: { providerId: "builtin-local", modelId: "extractive-ingest" },
      organization: organizationChoice,
    }) });
    mockReadDaily(null, exactRaw);
    localTransform.mockResolvedValue({ answer: "The earlier digest is bound to its source revision. [[daily/2026-08-10]]",
      model_id: BUILTIN_FAST_CHAT_MODEL, used_sources: ["daily/2026-08-10.md"], selected_chunks: 1 });
    const result = await runWeeklyRollup("/v");
    expect(localTransform).toHaveBeenCalledWith(expect.objectContaining({ modelId: BUILTIN_FAST_CHAT_MODEL, kind: "organize" }));
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile.mock.calls[0][1]).toContain(BUILTIN_FAST_CHAT_MODEL);
    expect(result).toMatchObject({ bucketsRolledUp: 1, sourcesArchived: 1 });
  });

  it("calls the local model once per bucket and retains evidence beyond its six-chunk preview", async () => {
    const page = "daily/2026-08-10.md";
    const raw = Array.from({ length: 48 }, (_, index) =>
      `**User:**\n\nSynthetic history WEEK-${index} retains an earlier decision and does not infer whether it was executed.`,
    ).join("\n\n");
    const source = sourceEvidence(page, raw, "2026-W33");
    expect(source.chunks).toHaveLength(48);
    getDistillConfig.mockResolvedValue({ ...CFG, llm_digest_days: 2 });
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-W33", files: [page] },
      { bucket: "2026-W34", files: ["daily/2026-08-17.md"] },
    ]);
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/weekly/")) throw new Error("ENOENT: no such file or directory");
      return { raw: path === `/v/${page}` ? raw : exactRaw };
    });
    localTransform.mockImplementation(async (request) => ({
      answer: `- Organized synthetic history [[${request.sources[0].page.replace(/\.md$/, "")}]]`,
      model_id: BUILTIN_CHAT_MODEL,
      used_sources: [request.sources[0].page],
      selected_chunks: request.sources.length,
    }));

    const result = await runWeeklyRollup("/v");

    expect(localTransform).toHaveBeenCalledTimes(2);
    for (const [request] of localTransform.mock.calls) {
      expect(request).toMatchObject({ kind: "organize", expectedVault: "/v", modelId: BUILTIN_CHAT_MODEL });
      expect(request.sources.length).toBeGreaterThan(0);
      expect(request.sources.length).toBeLessThanOrEqual(6);
    }
    const request = localTransform.mock.calls[0][0];
    for (const selected of request.sources) {
      expect(selected).toMatchObject({ page, revision: source.revision });
      expect(selected.revision).toMatch(/^[0-9a-f]{8}$/);
      expect(source.chunks.some(chunk => chunk.text === selected.text)).toBe(true);
    }
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(2);
    const content = writeFile.mock.calls[0][1] as string;
    expect(content).toContain("Organized synthetic history");
    expect(content).toContain("low confidence");
    expect(content).toContain(BUILTIN_CHAT_MODEL);
    expect(content).toContain("Local preview from");
    expect(content).toMatch(new RegExp(`${request.sources.length}\\s*(?:/|of)\\s*48`));
    for (const chunk of source.chunks) expect(content).toContain(chunk.text);
    expect(evidenceCoverage(content).get(`${page}\u0000${source.revision}`))
      .toEqual(new Set(source.chunks.map(chunk => chunk.id)));
    expect(archiveRolled).toHaveBeenCalledWith("/v", "weekly", "2026-W33", [page], [source.revision], expect.objectContaining({ origin: ORIGIN, manifestId: expect.stringMatching(/^llm-\d+$/), publications: expect.any(Array) }));
    expect(archiveRolled).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ bucketsRolledUp: 2, sourcesArchived: 2 });
  });

  it("keeps original evidence active when the selected local model is unavailable", async () => {
    mockReadDaily(null, exactRaw);
    localTransform.mockResolvedValue({
      answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "model_missing",
    });

    const result = await runWeeklyRollup("/v");

    expect(localTransform).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(archiveRolled).not.toHaveBeenCalled();
    expect(result).toMatchObject({ bucketsRolledUp: 0, sourcesArchived: 0, sourcesPending: 1, status: "pending" });
    expect(result.issues?.[0]).toMatchObject({ code: "model_missing", retryable: true });
  });

  it("keeps the source pending when no normalized chunk is an exact original excerpt", async () => {
    mockReadDaily();
    const page = "daily/2026-08-10.md";
    const source = sourceEvidence(page, DAILY_RAW, "2026-W33");
    expect(source.chunks.every(chunk => !DAILY_RAW.includes(chunk.text))).toBe(true);
    const result = await runWeeklyRollup("/v");
    expect(localTransform).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(archiveRolled).not.toHaveBeenCalled();
    expect(result).toMatchObject({ bucketsRolledUp: 0, sourcesArchived: 0, sourcesPending: 1, status: "pending" });
  });

  it("selects only exact original excerpts from a real receipt-bearing digest", async () => {
    const transcript = Array.from({ length: 12 }, (_, index) =>
      `**User:**\n\nSynthetic previous decision ITEM-${index} remains a proposal, and its execution has not been recorded.`,
    ).join("\n\n");
    const original = sourceEvidence("sessions/synthetic.md", transcript, "2026-08-10");
    const raw = "# Daily digest\n\n<!-- myco:digested-sessions synthetic:aaaaaaaa -->\n" + evidenceSection([original], original.chunks);
    const page = "daily/2026-08-10.md";
    const evidence = sourceEvidence(page, raw, "2026-W33");
    expect(evidence.chunks.some(chunk => !raw.includes(chunk.text))).toBe(true);
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/weekly/")) throw new Error("ENOENT: no such file or directory");
      return { raw };
    });
    localTransform.mockImplementation(async request => ({
      answer: "The previous digest records proposals without execution outcomes. [[daily/2026-08-10]]",
      model_id: BUILTIN_CHAT_MODEL, used_sources: [page], selected_chunks: request.sources.length,
    }));
    const result = await runWeeklyRollup("/v");
    expect(localTransform).toHaveBeenCalledOnce();
    const request = localTransform.mock.calls[0][0];
    expect(request.sources.length).toBeGreaterThan(0);
    expect(request.sources.length).toBeLessThanOrEqual(6);
    for (const selected of request.sources) {
      expect(raw).toContain(selected.text);
      expect(selected.revision).toBe(evidence.revision);
    }
    expect(writeFile.mock.calls[0][1]).toContain("The previous digest records proposals");
    expect(evidenceCoverage(writeFile.mock.calls[0][1]).get(`${page}\u0000${evidence.revision}`))
      .toEqual(new Set(evidence.chunks.map(chunk => chunk.id)));
    expect(writeFile.mock.calls[0][1]).toContain("ITEM-0");
    expect(writeFile.mock.calls[0][1]).toContain("ITEM-11");
    expect(result).toMatchObject({ bucketsRolledUp: 1, sourcesArchived: 1 });
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects an unselected source changed during an unavailable local preview", async () => {
    const first = "daily/2026-08-10.md";
    const second = "daily/2026-08-11.md";
    const firstRaw = Array.from({ length: 7 }, (_, index) =>
      `**User:**\n\nSynthetic selected history FIRST-${index} retains an earlier proposal without asserting execution.`,
    ).join("\n\n");
    const secondRaw = Array.from({ length: 41 }, (_, index) =>
      `**User:**\n\nSynthetic unselected history SECOND-${index} must preserve its exact source revision.`,
    ).join("\n\n");
    const firstSource = sourceEvidence(first, firstRaw, "2026-W33");
    const secondSource = sourceEvidence(second, secondRaw, "2026-W33");
    expect(firstSource.chunks).toHaveLength(7);
    expect(secondSource.chunks).toHaveLength(41);
    const files = new Map([[`/v/${first}`, firstRaw], [`/v/${second}`, secondRaw]]);
    rollupableBuckets.mockResolvedValue([{ bucket: "2026-W33", files: [first, second] }]);
    readFile.mockImplementation(async (path: string) => {
      const raw = files.get(path);
      if (raw === undefined) throw new Error("ENOENT: no such file or directory");
      return { raw };
    });
    localTransform.mockImplementation(async (request) => {
      expect(request.sources).toHaveLength(6);
      expect(request.sources.every((source: { page: string; revision: string }) =>
        source.page === first && source.revision === firstSource.revision)).toBe(true);
      files.set(`/v/${second}`, `${secondRaw}\nA late synthetic correction supersedes SECOND-40.`);
      return {
        answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "model_missing",
      };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await runWeeklyRollup("/v");

      expect(localTransform).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();
      expect(writeFileIfUnchanged.mock.calls.length).toBe(0);
      expect(writeFile).not.toHaveBeenCalled();
      expect(archiveRolled).not.toHaveBeenCalled();
      expect(appendDistillManifest).not.toHaveBeenCalled();
      expect(readFile.mock.calls.filter(([path]) => path === `/v/${second}`).length).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({ bucketsRolledUp: 0, sourcesArchived: 0 });
    } finally {
      error.mockRestore();
    }
  });

  it("does not write or archive source evidence rejected by native verification", async () => {
    mockReadDaily(null, exactRaw);
    localTransform.mockResolvedValue({
      answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "source_verification_failed",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await runWeeklyRollup("/v");

      expect(localTransform).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();
      expect(writeFileIfUnchanged).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(archiveRolled).not.toHaveBeenCalled();
      expect(appendDistillManifest).not.toHaveBeenCalled();
      expect(result).toMatchObject({ bucketsRolledUp: 0, sourcesArchived: 0 });
    } finally {
      error.mockRestore();
    }
  });
});

describe("runMonthlyRollup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    archiveRolled.mockImplementation(async (_vault: string, _layer: string, _bucket: string, paths: string[], _fingerprints: string[], options: ArchiveOptions) => archiveSuccess(paths, options));
    appendDistillManifest.mockResolvedValue(null);
    writeFile.mockResolvedValue(null);
    createFolder.mockResolvedValue(null);
  });

  it("rolls weekly/ into monthly/<YYYY-MM>.md and archives the weeks it covered", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
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
      if (path.includes("/monthly/")) throw new Error("ENOENT: no such file or directory");
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
      [fp, fp], expect.objectContaining({ origin: ORIGIN, manifestId: expect.stringMatching(/^llm-\d+$/), publications: expect.any(Array) }));
    expect(archiveRolled.mock.calls[0][5].publications).toEqual([{ path: "monthly/2026-07.md", revision: await sha256(writeFile.mock.calls[0][1]), created: true }]);
    expect(appendDistillManifest).not.toHaveBeenCalled();
    expect(result).toEqual({
      bucketsRolledUp: 1,
      sourcesArchived: 2,
      skipped: null,
      mode: "llm",
      chunksProcessed: 2,
    });
  });

  it("does not archive monthly evidence when the selected provider fails", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    rollupableBuckets.mockResolvedValue([
      { bucket: "2026-07", files: ["weekly/2026-W27.md"] },
    ]);
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/monthly/")) throw new Error("ENOENT: no such file or directory");
      return { raw: "# w\n- something worth quoting in a rollup" };
    });
    complete.mockRejectedValue(new Error("provider down"));

    const result = await runMonthlyRollup("/v");

    expect(archiveRolled).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ bucketsRolledUp: 0, sourcesArchived: 0, sourcesPending: 1, status: "failed" });
    expect(result.issues?.[0].error).toContain("provider down");
  });
});
