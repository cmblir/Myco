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
const digestableSessionDays = vi.fn();
const archiveDigestedSessions = vi.fn();
const appendDistillManifest = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const writeFileIfUnchanged = vi.fn();
const publishDistillNote = vi.fn();
let openingSequence = 0;
const createFolder = vi.fn();
const createFile = vi.fn();
const embedLocalTexts = vi.fn();
const localTransform = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    agentVaultSession: async () => ORIGIN,
    captureModelRole: (...a: unknown[]) => captureModelRole(...a),
    getDistillConfig: (...a: unknown[]) => getDistillConfig(...a),
    getSettings: (...a: unknown[]) => getSettings(...a),
    digestableSessionDays: (...a: unknown[]) => digestableSessionDays(...a),
    archiveDigestedSessions: (...a: unknown[]) => archiveDigestedSessions(...a),
    appendDistillManifest: (...a: unknown[]) => appendDistillManifest(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    writeFileIfUnchanged: (...a: unknown[]) => writeFileIfUnchanged(...a),
    publishDistillNote: (...a: unknown[]) => publishDistillNote(...a),
    createFolder: (...a: unknown[]) => createFolder(...a),
    createFile: (...a: unknown[]) => createFile(...a),
    embedLocalTexts: (...a: unknown[]) => embedLocalTexts(...a),
    localTransform: (...a: unknown[]) => localTransform(...a),
  },
}));

import { appendEvidenceDigest, runSessionDigest, DIGEST_SYSTEM, fingerprint, mmrSelect } from "./sessionDigest";

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

const SESSION_RAW = "user did X, decided Y";

// Shared session-file content stub for readFile — used both for the session
// logs (path under /sessions/) and the daily-note check (path under /daily/,
// mocked to "not found" so the append path creates the file fresh).
function mockReadFile(dailyExisting: string | null = null): void {
  readFile.mockImplementation(async (path: string) => {
    if (path.includes("/daily/")) {
      if (dailyExisting !== null) {
        return { path, raw: dailyExisting, content: dailyExisting, frontmatter: null };
      }
      throw new Error("ENOENT: no such file or directory");
    }
    return { path, raw: SESSION_RAW, content: SESSION_RAW, frontmatter: null };
  });
}

// Deterministic stand-in for the local embedder: char-code-derived vectors,
// same text → same vector, distinct texts → (almost always) distinct vectors.
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
  digestableSessionDays.mockReset();
  archiveDigestedSessions.mockReset();
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
  createFile.mockReset();
  embedLocalTexts.mockReset();
  localTransform.mockReset();
  embedLocalTexts.mockImplementation(async (texts: string[]) => mockEmbeddings(texts));
  createFolder.mockResolvedValue("daily");
  createFile.mockResolvedValue("daily/x.md");
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
  archiveDigestedSessions.mockImplementation(async (_vault: string, _day: string, paths: string[], _fingerprints: string[], options: ArchiveOptions) => archiveSuccess(paths, options));
  appendDistillManifest.mockResolvedValue(null);
});

describe("DIGEST_SYSTEM", () => {
  it("instructs bullets-only extraction with an uncertainty marker", () => {
    expect(DIGEST_SYSTEM).toContain("(uncertain)");
  });
});

// A session doc in the importer's format (importers/mod.rs to_inbox_doc),
// long enough per turn to clear the extractive path's MIN_UNIT_CHARS.
const TURNED_RAW = [
  "---",
  "source: claude-code",
  "conversation_id: abc",
  "---",
  "",
  "# fixing the retry loop",
  "",
  "**User:**",
  "",
  "the archive retry loops forever when the fingerprint changed under it, can you fix that path",
  "",
  "**Assistant:**",
  "",
  "decided to bind the marker to content fingerprints so a resumed conversation misses its old record",
  "",
  "**Assistant:**",
  "",
  "shipped the fix: archive_digested_sessions now re-checks each file against the marker before moving",
  "",
].join("\n");

function mockReadTurned(): void {
  readFile.mockImplementation(async (path: string) => {
    if (path.includes("/daily/")) throw new Error("ENOENT: no such file or directory");
    return { path, raw: TURNED_RAW, content: TURNED_RAW, frontmatter: null };
  });
}

describe("runSessionDigest", () => {
  it("reuses the source/publication journal ID when retrying an already written digest", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([{ day: "2026-08-10", files: ["sessions/2026-08-10/a.md"] }]);
    let note: string | null = null;
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/daily/")) {
        if (note === null) throw new Error("ENOENT: no such file or directory");
        return { raw: note };
      }
      return { raw: SESSION_RAW };
    });
    writeFile.mockImplementation(async (_path: string, raw: string) => { note = raw; });
    complete.mockResolvedValue("- Synthetic source-backed preview");
    archiveDigestedSessions.mockRejectedValueOnce(new Error("synthetic archive unavailable"));
    const first = await runSessionDigest("/v");
    const second = await runSessionDigest("/v");
    expect(first).toMatchObject({ filesArchived: 0, filesPending: 1, status: "partial" });
    expect(second).toMatchObject({ filesArchived: 1 });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    const firstOptions = archiveDigestedSessions.mock.calls[0][4] as ArchiveOptions;
    const secondOptions = archiveDigestedSessions.mock.calls[1][4] as ArchiveOptions;
    expect(firstOptions.manifestId).toBe(secondOptions.manifestId);
    expect(firstOptions.publications[0]).toEqual({ path: "daily/2026-08-10.md", revision: await sha256(note!), created: true });
    expect(secondOptions.publications[0]).toEqual(firstOptions.publications[0]);
    expect(secondOptions.publicationIds).toEqual(firstOptions.publicationIds);
  });
  it("counts native moved receipts and retains a source declined by archive verification", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([{ day: "2026-08-10", files: ["sessions/2026-08-10/a.md"] }]);
    mockReadFile();
    complete.mockResolvedValue("- Synthetic source-backed preview");
    archiveDigestedSessions.mockResolvedValue({ manifestId: "llm-1", moved: [],
      pending: [{ path: "sessions/2026-08-10/a.md", reason: "synthetic fingerprint changed" }],
      skipped: [], createdNotePaths: ["daily/2026-08-10.md"], retryable: true });
    const result = await runSessionDigest("/v");
    expect(result).toMatchObject({ filesArchived: 0, filesPending: 1, status: "partial" });
    expect(result.issues?.[0].error).toContain("synthetic fingerprint changed");
  });
  it("skips with nothing when there are no digestable days", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([]);

    const result = await runSessionDigest("/v");

    expect(result).toEqual({ daysDigested: 0, filesArchived: 0, skipped: "nothing", mode: "llm" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("digests extractively on builtin-local: quoted bullets with stems, marker, archive — and no LLM call", async () => {
    selectOrganization({ provider: "builtin-local", model: "extractive-ingest" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/claude-code-abc.md"] },
    ]);
    mockReadTurned();

    const result = await runSessionDigest("/v");

    expect(complete).not.toHaveBeenCalled();
    expect(embedLocalTexts).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0];
    expect(path).toBe("/v/daily/2026-08-10.md");
    // Same heading contract as the LLM path, extractive label in the sub-line.
    expect(content).toContain("## Session digest (auto)");
    expect(content).toContain("extractive quotes (no LLM)");
    // Quoted bullets grouped under the session, which is named ONCE (ROADMAP
    // P1) — not repeated as a `— <stem>` suffix on every line.
    expect(content).toContain("**claude-code-abc**");
    expect(content.match(/claude-code-abc\*\*/g)).toHaveLength(1);
    expect(content).toMatch(/\*\*claude-code-abc\*\*\n- ".+"/);
    expect(content).toContain(
      `<!-- myco:digested-sessions claude-code-abc:${fingerprint(TURNED_RAW)} -->`,
    );
    // Same fingerprints, same archive flow as the LLM path.
    expect(archiveDigestedSessions).toHaveBeenCalledWith(
      "/v",
      "2026-08-10",
      ["sessions/2026-08-10/claude-code-abc.md"],
      [fingerprint(TURNED_RAW)], expect.objectContaining({ origin: ORIGIN, manifestId: expect.stringMatching(/^llm-\d+$/), publications: expect.any(Array) }));
    expect(result).toEqual({ daysDigested: 1, filesArchived: 1, skipped: null, mode: "extractive", chunksProcessed: 4 });
  });

  it("strips leading filler before embedding, so a pure-acknowledgment turn is never a candidate", async () => {
    selectOrganization({ provider: "builtin-local", model: "extractive-ingest" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/claude-code-kor.md"] },
    ]);
    const raw = [
      "**User:**",
      "",
      "네, 감사합니다! 좋아요.",
      "",
      "**Assistant:**",
      "",
      "알겠습니다. 마커를 내용 지문에 묶었으므로 이어서 진행한 대화는 예전 기록과 일치하지 않습니다.",
      "",
    ].join("\n");
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/daily/")) throw new Error("ENOENT: no such file or directory");
      return { path, raw, content: raw, frontmatter: null };
    });

    await runSessionDigest("/v");

    const units = embedLocalTexts.mock.calls[0][0] as string[];
    // The all-filler turn fell under MIN_UNIT_CHARS once stripped; the real
    // turn kept its content but lost its "알겠습니다." preamble.
    expect(units).toEqual([
      "마커를 내용 지문에 묶었으므로 이어서 진행한 대화는 예전 기록과 일치하지 않습니다.",
    ]);
    const content = writeFile.mock.calls[0][1] as string;
    expect(content.split("### Source evidence")[0]).not.toContain("알겠습니다");
    expect(content.split("### Source evidence")[0]).not.toContain("감사합니다");
    // The source-backed evidence keeps the original wording even when the
    // short preview filters acknowledgments.
    expect(content).toContain("알겠습니다");
  });

  it("produces byte-identical extractive output for the same inputs", async () => {
    selectOrganization({ provider: "builtin-local", model: "extractive-ingest" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/claude-code-abc.md"] },
    ]);
    mockReadTurned();

    await runSessionDigest("/v");
    const first = writeFile.mock.calls[0][1] as string;
    writeFile.mockClear();
    await runSessionDigest("/v");
    const second = writeFile.mock.calls[0][1] as string;

    expect(second).toBe(first);
  });

  it("retains a legacy covered day on builtin-local for manual recovery", async () => {
    selectOrganization({ provider: "builtin-local", model: "extractive-ingest" });
    getDistillConfig.mockResolvedValue(CFG);
    // Rust flagged these files already_digested from a marker written by ANY
    // earlier run (LLM or extractive) — a provider change never re-digests.
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"], already_digested: true },
    ]);
    const source = sourceEvidence("sessions/2026-08-10/a.md", SESSION_RAW, "2026-08-10");
    mockReadFile("# 2026-08-10\n" + evidenceSection([source], source.chunks));

    const result = await runSessionDigest("/v");

    expect(embedLocalTexts).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(archiveDigestedSessions).not.toHaveBeenCalled();
    expect(publishDistillNote).not.toHaveBeenCalled();
    expect(result).toMatchObject({ daysDigested: 0, filesArchived: 0, filesPending: 1, status: "pending", mode: "extractive" });
    expect(result.issues?.[0].error).toContain("manual recovery");
  });

  it("digests only the first llm_digest_days day, one complete() call, one archive call, and appends the daily note", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
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
      task: "generate",
      cwd: "/v",
    });
    expect(complete.mock.calls[0][0].messages[0]).toEqual({
      role: "system",
      content: DIGEST_SYSTEM,
    });
    expect(archiveDigestedSessions).toHaveBeenCalledTimes(1);
    // Race guard: the fingerprints handed to the archive step are the ones
    // the marker recorded, so Rust can leave behind a file the auto-collect
    // sweep rewrote between the read above and the move.
    expect(archiveDigestedSessions).toHaveBeenCalledWith(
      "/v",
      "2026-08-10",
      ["sessions/2026-08-10/a.md"],
      [fingerprint(SESSION_RAW)], expect.objectContaining({ origin: ORIGIN, manifestId: expect.stringMatching(/^llm-\d+$/), publications: expect.any(Array) }));
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0];
    expect(path).toBe("/v/daily/2026-08-10.md");
    expect(content).toContain("## Session digest (auto)");
    expect(content).toContain("low confidence");
    expect(content).toContain("Decided to use X");
    // A real LLM provider never routes through the extractive machinery.
    expect(embedLocalTexts).not.toHaveBeenCalled();
    expect(result).toEqual({ daysDigested: 1, filesArchived: 1, skipped: null, mode: "llm", chunksProcessed: 1 });
    // Important 4 (Phase B whole-branch review): the daily file was created
    // fresh (mockReadFile()'s default "not found" for /daily/), so its
    // creation is folded into archiveDigestedSessions' own manifest id.
    expect(archiveDigestedSessions.mock.calls[0][4].publications).toEqual([{ path: "daily/2026-08-10.md", revision: await sha256(writeFile.mock.calls[0][1]), created: true }]);
    expect(appendDistillManifest).not.toHaveBeenCalled();
    // Defect C fix: the SAME write that carries the digest text names the
    // session files it covers, so there is no window where the digest is
    // durable but the record of it isn't. Rust's digested_session_entries
    // parses this line back — stem AND content fingerprint, so a resumed
    // conversation that keeps its stem does not match its own older record.
    expect(content).toContain(`<!-- myco:digested-sessions a:${fingerprint(SESSION_RAW)} -->`);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("does not infer native ownership from an already-recorded legacy day", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"], already_digested: true },
    ]);
    const source = sourceEvidence("sessions/2026-08-10/a.md", SESSION_RAW, "2026-08-10");
    mockReadFile("# 2026-08-10\n" + evidenceSection([source], source.chunks));

    const result = await runSessionDigest("/v");

    expect(complete).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith("/v/sessions/2026-08-10/a.md");
    expect(writeFile).not.toHaveBeenCalled();
    expect(archiveDigestedSessions).not.toHaveBeenCalled();
    expect(publishDistillNote).not.toHaveBeenCalled();
    expect(result).toMatchObject({ daysDigested: 0, filesArchived: 0, filesPending: 1, status: "pending", mode: "llm" });
    expect(result.issues?.[0].error).toContain("manual recovery");
  });

  it("rejects tokenless legacy recovery before a failing archive can run", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"], already_digested: true },
    ]);
    const source = sourceEvidence("sessions/2026-08-10/a.md", SESSION_RAW, "2026-08-10");
    mockReadFile("# 2026-08-10\n" + evidenceSection([source], source.chunks));
    archiveDigestedSessions.mockRejectedValue(new Error("disk full"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runSessionDigest("/v");

    expect(complete).not.toHaveBeenCalled();
    expect(archiveDigestedSessions).not.toHaveBeenCalled();
    expect(publishDistillNote).not.toHaveBeenCalled();
    expect(result).toMatchObject({ daysDigested: 0, filesArchived: 0, skipped: null, mode: "llm", status: "pending", filesPending: 1 });
    expect(result.issues?.[0].error).toContain("manual recovery");
    errSpy.mockRestore();
  });

  it("does not archive or consume coverage when the conditional note write fails", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([{ day: "2026-08-10", files: ["sessions/2026-08-10/a.md"] }]);
    mockReadFile();
    complete.mockResolvedValue("- Synthetic source-backed preview");
    writeFileIfUnchanged.mockRejectedValue(new Error("synthetic CAS unavailable"));
    const result = await runSessionDigest("/v");
    expect(result).toMatchObject({ daysDigested: 0, filesArchived: 0, filesPending: 1, status: "failed" });
    expect(result.issues?.[0].error).toContain("synthetic CAS unavailable");
    expect(archiveDigestedSessions).not.toHaveBeenCalled();
    expect(appendDistillManifest).not.toHaveBeenCalled();
  });

  it("keeps sources active when native publication journal recording fails", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([{ day: "2026-08-10", files: ["sessions/2026-08-10/a.md"] }]);
    mockReadFile();
    complete.mockResolvedValue("- Synthetic source-backed preview");
    archiveDigestedSessions.mockRejectedValue(new Error("synthetic manifest save failed"));
    const result = await runSessionDigest("/v");
    expect(result).toMatchObject({ daysDigested: 0, filesArchived: 0, chunksProcessed: 1, filesPending: 1, status: "partial" });
    expect(result.issues?.[0]).toMatchObject({ status: "failed", retryable: true });
    expect(result.issues?.[0].error).toContain("synthetic manifest save failed");
  });

  it("resumes bounded coverage and retains all sources when an update lacks creation authority", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    const active = new Map([
      ["sessions/2026-08-10/a.md", "x".repeat(50_000)],
      ["sessions/2026-08-10/b.md", "y".repeat(50_000)],
      ["sessions/2026-08-10/c.md", "small tail content with exact name ORION"],
    ]);
    const notes = new Map<string, string>();
    digestableSessionDays.mockImplementation(async () => [{ day: "2026-08-10", files: [...active.keys()] }]);
    readFile.mockImplementation(async (path: string) => {
      const raw = notes.get(path) ?? active.get(path.replace("/v/", ""));
      if (raw === undefined) throw new Error("ENOENT: no such file or directory");
      return { raw };
    });
    writeFile.mockImplementation(async (path: string, raw: string) => { notes.set(path, raw); });
    archiveDigestedSessions.mockImplementation(async (_vault: string, _day: string, paths: string[], _fingerprints: string[], options: ArchiveOptions) => {
      paths.forEach(path => active.delete(path));
      return archiveSuccess(paths, options);
    });
    complete.mockResolvedValue("- bounded preview");
    const first = await runSessionDigest("/v");
    expect(first).toMatchObject({ filesArchived: 0, filesPending: 3, chunksProcessed: 48 });
    expect(archiveDigestedSessions.mock.calls[0][2]).toEqual([]);
    expect(complete.mock.calls[0][0].messages[1].content.length).toBeLessThan(40_000);
    expect(notes.get("/v/daily/2026-08-10.md")).not.toContain("myco:digested-sessions");
    await runSessionDigest("/v");
    expect(active.has("sessions/2026-08-10/b.md")).toBe(true);
    await runSessionDigest("/v");
    await runSessionDigest("/v");
    const last = await runSessionDigest("/v");
    expect(active.size).toBe(3);
    expect(last).toMatchObject({ filesArchived: 0, filesPending: 3, status: "partial" });
    expect(last.issues?.[0].error).toContain("manual recovery");
    expect(archiveDigestedSessions).toHaveBeenCalledTimes(1);
    expect(archiveDigestedSessions.mock.calls[0][2]).toEqual([]);
    expect(notes.get("/v/daily/2026-08-10.md")).toContain("exact name ORION");
    expect(notes.get("/v/daily/2026-08-10.md")).toContain("[[sessions/2026-08-10/c.md]]");
    expect(complete).toHaveBeenCalledTimes(5);
  });

  it("appends under a sub-line instead of duplicating the header when one already exists for that day", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
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
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
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

    const fp = fingerprint(SESSION_RAW);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][1]).toContain(
      `<!-- myco:digested-sessions claude-code-aaa:${fp} codex-bbb:${fp} -->`,
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
    expect(second).toContain(`<!-- myco:digested-sessions codex-ccc:${fp} -->`);
    expect(second.match(/myco:digested-sessions/g)).toHaveLength(2);
  });

  it("keeps all remaining inputs retryable when the selected writing provider fails", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
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
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ daysDigested: 0, filesArchived: 0, filesPending: 2, status: "failed" });
    expect(result.issues?.[0]).toMatchObject({ step: "digest", status: "failed", retryable: true });
    expect(result.issues?.[0].error).toContain("provider boom");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("seeds an existing blank daily file without claiming it as a native creation", async () => {
    selectOrganization({ provider: "anthropic-api", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"] },
    ]);
    // A crash between the old create step and the write left a zero-byte
    // daily/2026-08-10.md: readFile succeeds, so the retry used to skip the
    // only branch that seeds the title and sets `created`.
    mockReadFile("");
    complete.mockResolvedValue("- New bullet");

    await runSessionDigest("/v");

    const content = writeFile.mock.calls[0][1] as string;
    expect(content.startsWith("# 2026-08-10\n")).toBe(true);
    expect(content).toContain("New bullet");
    expect(publishDistillNote.mock.calls[0][4]).toBe(await sha256(""));
    expect(archiveDigestedSessions).not.toHaveBeenCalled();
    expect(appendDistillManifest).not.toHaveBeenCalled();
    // The atomic write creates the file itself — no separate create step to
    // crash between any more.
    expect(createFile).not.toHaveBeenCalled();
  });
});

describe("runSessionDigest with a selected local organizer", () => {
  beforeEach(() => {
    selectOrganization({ provider: "builtin-local", model: BUILTIN_CHAT_MODEL });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/synthetic.md"] },
    ]);
  });

  it("uses the explicitly selected Organization generator independently of quote-only Ask", async () => {
    selectOrganization({ provider: "builtin-local", model: BUILTIN_FAST_CHAT_MODEL });
    getSettings.mockResolvedValue({ model_roles: selectedRolesFixture({
      ask: { providerId: "builtin-local", modelId: "extractive-retrieval" },
      compilation: { providerId: "builtin-local", modelId: "extractive-ingest" },
      organization: organizationChoice,
    }) });
    mockReadFile();
    localTransform.mockResolvedValue({ answer: "An earlier decision is recorded. [[sessions/2026-08-10/synthetic]]",
      model_id: BUILTIN_FAST_CHAT_MODEL, used_sources: ["sessions/2026-08-10/synthetic.md"], selected_chunks: 1 });
    const result = await runSessionDigest("/v");
    expect(localTransform).toHaveBeenCalledWith(expect.objectContaining({ modelId: BUILTIN_FAST_CHAT_MODEL, kind: "organize" }));
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile.mock.calls[0][1]).toContain(BUILTIN_FAST_CHAT_MODEL);
    expect(writeFile.mock.calls[0][1]).toContain("Local preview from 1/1 chunks");
    expect(result).toMatchObject({ daysDigested: 1, filesArchived: 1 });
  });

  it("generates one bounded preview while retaining all 48 source quotes and coverage", async () => {
    const page = "sessions/2026-08-10/synthetic.md";
    const raw = Array.from({ length: 48 }, (_, index) =>
      `**User:**\n\nSynthetic decision DAY-${index} preserves its original evidence and remains uncertain until explicitly confirmed.`,
    ).join("\n\n");
    const source = sourceEvidence(page, raw, "2026-08-10");
    expect(source.chunks).toHaveLength(48);
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("/daily/")) throw new Error("ENOENT: no such file or directory");
      return { raw };
    });
    localTransform.mockResolvedValue({
      answer: "- Synthetic decisions remain uncertain [[sessions/2026-08-10/synthetic]]",
      model_id: BUILTIN_CHAT_MODEL,
      used_sources: [page],
      selected_chunks: 6,
    });

    const result = await runSessionDigest("/v");

    expect(localTransform).toHaveBeenCalledTimes(1);
    const request = localTransform.mock.calls[0][0];
    expect(request).toMatchObject({ kind: "organize", expectedVault: "/v", modelId: BUILTIN_CHAT_MODEL });
    expect(request.sources.length).toBeGreaterThan(0);
    expect(request.sources.length).toBeLessThanOrEqual(6);
    for (const selected of request.sources) {
      expect(selected).toMatchObject({ page, revision: source.revision });
      expect(selected.revision).toMatch(/^[0-9a-f]{8}$/);
      expect(source.chunks.some(chunk => chunk.text === selected.text)).toBe(true);
    }
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(1);
    const content = writeFile.mock.calls[0][1] as string;
    expect(content).toContain("Synthetic decisions remain uncertain");
    expect(content).toContain("low confidence");
    expect(content).toContain(BUILTIN_CHAT_MODEL);
    expect(content).toContain("Local preview from");
    expect(content).toMatch(new RegExp(`${request.sources.length}\\s*(?:/|of)\\s*48`));
    for (const chunk of source.chunks) expect(content).toContain(chunk.text);
    expect(evidenceCoverage(content).get(`${page}\u0000${source.revision}`))
      .toEqual(new Set(source.chunks.map(chunk => chunk.id)));
    expect(archiveDigestedSessions).toHaveBeenCalledWith("/v", "2026-08-10", [page], [source.revision], expect.objectContaining({ origin: ORIGIN, manifestId: expect.stringMatching(/^llm-\d+$/), publications: expect.any(Array) }));
    expect(result).toMatchObject({ daysDigested: 1, filesArchived: 1, chunksProcessed: 48 });
  });

  it("keeps original evidence active when the selected local model is unavailable", async () => {
    mockReadFile();
    localTransform.mockResolvedValue({
      answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "model_missing",
    });

    const result = await runSessionDigest("/v");

    expect(localTransform).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(archiveDigestedSessions).not.toHaveBeenCalled();
    expect(result).toMatchObject({ daysDigested: 0, filesArchived: 0, filesPending: 1, status: "pending" });
    expect(result.issues?.[0]).toMatchObject({ code: "model_missing", retryable: true });
  });

  it("rejects an unselected source changed during successful local generation", async () => {
    const first = "sessions/2026-08-10/first.md";
    const second = "sessions/2026-08-10/second.md";
    const firstRaw = Array.from({ length: 7 }, (_, index) =>
      `**User:**\n\nSynthetic selected decision FIRST-${index} retains its original quoted evidence.`,
    ).join("\n\n");
    const secondRaw = Array.from({ length: 41 }, (_, index) =>
      `**User:**\n\nSynthetic unselected decision SECOND-${index} must remain bound to its original revision.`,
    ).join("\n\n");
    const firstSource = sourceEvidence(first, firstRaw, "2026-08-10");
    const secondSource = sourceEvidence(second, secondRaw, "2026-08-10");
    expect(firstSource.chunks).toHaveLength(7);
    expect(secondSource.chunks).toHaveLength(41);
    const files = new Map([[`/v/${first}`, firstRaw], [`/v/${second}`, secondRaw]]);
    digestableSessionDays.mockResolvedValue([{ day: "2026-08-10", files: [first, second] }]);
    readFile.mockImplementation(async (path: string) => {
      const raw = files.get(path);
      if (raw === undefined) throw new Error("ENOENT: no such file or directory");
      return { raw };
    });
    localTransform.mockImplementation(async (request) => {
      expect(request.sources).toHaveLength(6);
      expect(request.sources.every((source: { page: string; revision: string }) =>
        source.page === first && source.revision === firstSource.revision)).toBe(true);
      files.set(`/v/${second}`, `${secondRaw}\nA late synthetic correction cancels SECOND-40.`);
      return {
        answer: "- Selected decisions retain evidence [[sessions/2026-08-10/first]]",
        model_id: BUILTIN_CHAT_MODEL, used_sources: [first], selected_chunks: 6,
      };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await runSessionDigest("/v");

      expect(localTransform).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();
      expect(writeFileIfUnchanged.mock.calls.length).toBe(0);
      expect(writeFile).not.toHaveBeenCalled();
      expect(archiveDigestedSessions).not.toHaveBeenCalled();
      expect(appendDistillManifest).not.toHaveBeenCalled();
      expect(readFile.mock.calls.filter(([path]) => path === `/v/${second}`).length).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({ daysDigested: 0, filesArchived: 0 });
    } finally {
      error.mockRestore();
    }
  });

  it("does not write or archive source evidence rejected by native verification", async () => {
    mockReadFile();
    localTransform.mockResolvedValue({
      answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "source_verification_failed",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await runSessionDigest("/v");

      expect(localTransform).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();
      expect(writeFileIfUnchanged).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(archiveDigestedSessions).not.toHaveBeenCalled();
      expect(appendDistillManifest).not.toHaveBeenCalled();
      expect(result).toMatchObject({ daysDigested: 0, filesArchived: 0 });
    } finally {
      error.mockRestore();
    }
  });
});

describe("mmrSelect", () => {
  it("picks the most centroid-relevant vector first, breaking ties by index", () => {
    // [1,0] twice and [0,1]: centroid [2,1] favors [1,0]; the tie between the
    // two duplicates goes to index 0.
    const picked = mmrSelect([[1, 0], [1, 0], [0, 1]], 1);
    expect(picked).toEqual([0]);
  });

  it("prefers a distinct vector over an exact duplicate of an earlier pick", () => {
    const picked = mmrSelect([[1, 0], [1, 0], [0, 1]], 2);
    expect(picked).toEqual([0, 2]);
  });

  it("returns every index (in some order) when k exceeds the pool, and [] for no vectors", () => {
    expect(mmrSelect([[1, 0], [0, 1]], 5).slice().sort()).toEqual([0, 1]);
    expect(mmrSelect([], 3)).toEqual([]);
  });
});

describe("fingerprint", () => {
  // Parity vectors: distill.rs's content_fingerprint reads back what this
  // writes, and its own test asserts these same two strings hash to these
  // same hex values.
  it("matches the Rust FNV-1a implementation over UTF-8 bytes", () => {
    expect(fingerprint("myco")).toBe("b73bd5ad");
    expect(fingerprint("한글 세션")).toBe("723f3e42");
    expect(fingerprint("")).toBe("811c9dc5");
  });
});

describe("appendEvidenceDigest", () => {
  it("keeps an editor save occurring between final read and conditional append", async () => {
    const source = sourceEvidence("sessions/day/a.md", "A synthetic decision explicitly retains its quoted source evidence.", "2026-10-04");
    let note = "# My day\nPersonal note\n";
    let attempts = 0;
    readFile.mockImplementation(async () => ({ raw: note }));
    writeFile.mockImplementation(async (_path: string, content: string) => { note = content; });
    writeFileIfUnchanged.mockImplementation(async (path: string, content: string, expected: string | null) => {
      if (++attempts === 1) note += "Late editor save\n";
      if (expected !== await sha256(note)) throw "write conflict: changed";
      await writeFile(path, content);
    });
    const result = await appendEvidenceDigest({
      vaultPath: "/v", origin: ORIGIN, directory: "daily", bucket: "2026-10-04", header: "## Session digest (auto)",
      sourceLabel: "session logs", sources: [source], batch: source.chunks, preview: "- Source preview",
      extractive: true, markerOpen: "<!-- myco:digested-sessions ",
      roleSnapshot: roleFixture("organization", "builtin-local", "extractive-ingest", ORIGIN),
    });
    expect(note).toContain("# My day\nPersonal note\nLate editor save\n");
    expect(note).toContain(source.chunks[0].text);
    expect(note.match(/### Source evidence/g)).toHaveLength(1);
    expect(result).toMatchObject({ created: false, complete: [source], publication: { path: "daily/2026-10-04.md", revision: await sha256(note), created: false },
      options: { origin: ORIGIN, publicationIds: ["b".repeat(64)] } });
    expect(writeFileIfUnchanged).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});
