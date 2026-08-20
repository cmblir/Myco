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
const embedLocalTexts = vi.fn();
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
    embedLocalTexts: (...a: unknown[]) => embedLocalTexts(...a),
  },
}));

import { runSessionDigest, DIGEST_SYSTEM, fingerprint, mmrSelect } from "./sessionDigest";

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
      throw new Error("not found");
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
  embedLocalTexts.mockReset();
  embedLocalTexts.mockImplementation(async (texts: string[]) => mockEmbeddings(texts));
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
    if (path.includes("/daily/")) throw new Error("not found");
    return { path, raw: TURNED_RAW, content: TURNED_RAW, frontmatter: null };
  });
}

describe("runSessionDigest", () => {
  it("skips with nothing when there are no digestable days", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    getDistillConfig.mockResolvedValue(CFG);
    digestableSessionDays.mockResolvedValue([]);

    const result = await runSessionDigest("/v");

    expect(result).toEqual({ daysDigested: 0, filesArchived: 0, skipped: "nothing", mode: "llm" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("digests extractively on builtin-local: quoted bullets with stems, marker, archive — and no LLM call", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "bge-m3" });
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
      [fingerprint(TURNED_RAW)],
    );
    expect(result).toEqual({ daysDigested: 1, filesArchived: 1, skipped: null, mode: "extractive" });
  });

  it("strips leading filler before embedding, so a pure-acknowledgment turn is never a candidate", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "bge-m3" });
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
      if (path.includes("/daily/")) throw new Error("not found");
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
    expect(content).not.toContain("알겠습니다");
    expect(content).not.toContain("감사합니다");
  });

  it("produces byte-identical extractive output for the same inputs", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "bge-m3" });
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

  it("does not re-digest an already-recorded day on builtin-local — only the archive is retried", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "bge-m3" });
    getDistillConfig.mockResolvedValue(CFG);
    // Rust flagged these files already_digested from a marker written by ANY
    // earlier run (LLM or extractive) — a provider change never re-digests.
    digestableSessionDays.mockResolvedValue([
      { day: "2026-08-10", files: ["sessions/2026-08-10/a.md"], already_digested: true },
    ]);

    const result = await runSessionDigest("/v");

    expect(embedLocalTexts).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(archiveDigestedSessions).toHaveBeenCalledWith(
      "/v",
      "2026-08-10",
      ["sessions/2026-08-10/a.md"],
      null,
    );
    expect(result).toEqual({ daysDigested: 1, filesArchived: 1, skipped: null, mode: "extractive" });
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
    // Race guard: the fingerprints handed to the archive step are the ones
    // the marker recorded, so Rust can leave behind a file the auto-collect
    // sweep rewrote between the read above and the move.
    expect(archiveDigestedSessions).toHaveBeenCalledWith(
      "/v",
      "2026-08-10",
      ["sessions/2026-08-10/a.md"],
      [fingerprint(SESSION_RAW)],
    );
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0];
    expect(path).toBe("/v/daily/2026-08-10.md");
    expect(content).toContain("## Session digest (auto)");
    expect(content).toContain("low confidence");
    expect(content).toContain("Decided to use X");
    // A real LLM provider never routes through the extractive machinery.
    expect(embedLocalTexts).not.toHaveBeenCalled();
    expect(result).toEqual({ daysDigested: 1, filesArchived: 1, skipped: null, mode: "llm" });
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
    // durable but the record of it isn't. Rust's digested_session_entries
    // parses this line back — stem AND content fingerprint, so a resumed
    // conversation that keeps its stem does not match its own older record.
    expect(content).toContain(`<!-- myco:digested-sessions a:${fingerprint(SESSION_RAW)} -->`);
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
    // No fingerprints on the retry path — this run read nothing; the marker
    // an earlier run wrote is the record Rust re-checks against.
    expect(archiveDigestedSessions).toHaveBeenCalledWith(
      "/v",
      "2026-08-10",
      ["sessions/2026-08-10/a.md"],
      null,
    );
    expect(result).toEqual({ daysDigested: 1, filesArchived: 1, skipped: null, mode: "llm" });
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
    expect(result).toEqual({ daysDigested: 0, filesArchived: 0, skipped: null, mode: "llm" });
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
    expect(result).toEqual({ daysDigested: 0, filesArchived: 0, skipped: null, mode: "llm" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("treats an existing-but-blank daily file as missing: seeds the title and still records the manifest", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
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
    // `created` is what makes this run's daily file visible to undo.
    expect(appendDistillManifest).toHaveBeenCalledWith(
      "/v",
      "digest-archived",
      [],
      ["daily/2026-08-10.md"],
    );
    // The atomic write creates the file itself — no separate create step to
    // crash between any more.
    expect(createFile).not.toHaveBeenCalled();
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
