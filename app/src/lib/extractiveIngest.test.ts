// Offline ingest must produce a page the project's own validator accepts and
// a page that never says anything the source did not. Both are asserted here
// against the frontmatter contract in `src-tauri/src/validator.rs`
// (validate_pages) and `src-tauri/src/vault.rs`'s VAULT_CLAUDE_MD.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { BUILTIN_CHAT_MODEL } from "./providers";
import { roleFixture, syntheticOrigin } from "./modelRoles.testSupport";
import { STRINGS } from "./i18n";
import {
  appendIndexEntry,
  appendLogEntry,
  extractiveReport,
  extractiveSummary,
  isoDate,
  leadPassages,
  matchedTags,
  reportRel,
  runExtractiveIngest,
} from "./extractiveIngest";
import type { ExtractiveIngestIO } from "./extractiveIngest";
import { sourceEvidence } from "./sessionEvidence";
import { sha256 } from "./tidyRun";
import { resolveStem } from "./wikilinks";

const t = STRINGS.en;
const NOW = new Date(2026, 8, 6, 14, 3, 9); // 2026-09-06 14:03:09 local

vi.mock("./ipc", () => ({ ipc: { localTransform: vi.fn(), cancelLocalSynthesis: vi.fn(),
  agentVaultSession: vi.fn(), captureModelRole: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.agentVaultSession).mockResolvedValue(syntheticOrigin);
  vi.mocked(ipc.captureModelRole).mockImplementation(async (origin, role, usage) =>
    roleFixture(role, "builtin-local", BUILTIN_CHAT_MODEL, origin, usage));
});

const SOURCE = [
  "# Retrieval notes",
  "",
  "Hybrid retrieval fuses a dense vector arm with a lexical arm, and the fusion is what recovers the queries neither arm answers alone.",
  "",
  "```rust",
  "let x = 1; // fenced code is not a claim",
  "```",
  "",
  "short",
  "",
  "Reciprocal rank fusion needs no score calibration between the two arms, which is exactly why it survives an embedding-model swap.",
  "",
  "A stray footnote marker [^src-somewhere-else] must not survive into the summary page.",
].join("\n");

describe("leadPassages", () => {
  it("quotes verbatim, skipping headings, fences and short blocks", () => {
    const out = leadPassages(SOURCE);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(
      "Hybrid retrieval fuses a dense vector arm with a lexical arm, and the fusion is what recovers the queries neither arm answers alone.",
    );
    expect(out[1]).toContain("Reciprocal rank fusion needs no score calibration");
    for (const p of out) {
      expect(p).not.toContain("# Retrieval notes");
      expect(p).not.toContain("let x = 1");
      expect(p).not.toBe("short");
    }
  });

  it("strips footnote markers so a source's own [^src-*] cannot dangle", () => {
    const out = leadPassages(SOURCE);
    expect(out.join("\n")).not.toContain("somewhere-else");
  });

  it("collapses a multi-line block to one line so it stays one list item", () => {
    const [p] = leadPassages("The claim begins here\nand continues on the next line of the same block.");
    expect(p).toBe(
      "The claim begins here and continues on the next line of the same block.",
    );
  });

  it("cuts an over-long passage with an ellipsis instead of dropping it", () => {
    const long = "가".repeat(900);
    const [p] = leadPassages(long, 5, 100);
    expect(p.endsWith("…")).toBe(true);
    expect(p.length).toBeLessThanOrEqual(101);
  });

  it("skips frontmatter", () => {
    const withFm = `---\ntitle: "x"\n---\n\n${SOURCE}`;
    expect(leadPassages(withFm).join("\n")).not.toContain("title:");
  });
});

describe("matchedTags", () => {
  it("reuses only existing vault tags that occur in the source", () => {
    expect(matchedTags(SOURCE, ["retrieval", "kubernetes", "fusion"])).toEqual([
      "retrieval",
      "fusion",
    ]);
  });

  it("invents nothing when the vault has no matching tag", () => {
    expect(matchedTags(SOURCE, ["kubernetes"])).toEqual([]);
  });
});

describe("extractiveSummary", () => {
  const summary = extractiveSummary(t, {
    slug: "retrieval-notes",
    title: "Retrieval notes",
    body: SOURCE,
    candidates: [
      { page: "wiki/hybrid-search.md", stem: "hybrid-search", score: 0.7 },
      { page: "wiki/rrf.md", stem: "rrf", score: 0.6 },
    ],
    vaultTags: ["retrieval", "fusion"],
    now: NOW,
  });

  it("writes to wiki/source-<slug>.md", () => {
    expect(summary.rel).toBe("wiki/source-retrieval-notes.md");
  });

  it("satisfies the frontmatter contract validate_pages enforces", () => {
    const fm = summary.content.split("---")[1];
    expect(fm).toContain('title: "Source: Retrieval notes"');
    expect(fm).toContain("type: source-summary");
    expect(fm).toContain(`created: ${isoDate(NOW)}`);
    expect(fm).toContain(`last_updated: ${isoDate(NOW)}`);
    expect(fm).toContain("source_count: 1");
    expect(fm).toContain("confidence: low");
    expect(fm).toContain("status: active");
    expect(fm).toContain("  - source-summary\n");
    expect(fm).toContain("  - retrieval\n");
  });

  it("cites every claim line and defines the footnote once", () => {
    const claims = summary.content
      .split("\n")
      .filter((l) => l.startsWith("- ") && !l.startsWith("- [["));
    expect(claims.length).toBe(summary.passages.length);
    expect(claims.length).toBeGreaterThan(0);
    for (const line of claims) {
      expect(line.endsWith("[^src-retrieval-notes]")).toBe(true);
    }
    expect(summary.content).toContain(
      "[^src-retrieval-notes]: [[source-retrieval-notes]]",
    );
    // Definition last, as on every wiki/source-*.md the sample vault ships.
    expect(summary.content.trimEnd().endsWith("[[source-retrieval-notes]]")).toBe(true);
  });

  it("cites exactly one distinct slug, matching source_count: 1", () => {
    const slugs = new Set(
      [...summary.content.matchAll(/\[\^src-([a-z0-9-]+)\]/g)].map((m) => m[1]),
    );
    expect([...slugs]).toEqual(["retrieval-notes"]);
  });

  it("invents no sentence — every claim is a substring of the source", () => {
    const flatSource = SOURCE.replace(/\[\^[^\]]*\]/g, "").replace(/\s+/g, " ");
    for (const p of summary.passages) {
      expect(flatSource).toContain(p.replace(/…$/, ""));
    }
  });

  it("links the embedder's candidates under ## Related", () => {
    expect(summary.content).toContain("## Related");
    expect(summary.content).toContain("- [[hybrid-search]]");
    expect(summary.content).toContain("- [[rrf]]");
    expect(summary.related).toEqual(["hybrid-search", "rrf"]);
  });

  it("links a transcript candidate through its summary, never the transcript", () => {
    // wikify_candidates ranks sessions/ transcripts too; their stems resolve to
    // nothing in wiki/, which is how 30 dangling links reached the real vault.
    const s = extractiveSummary(t, {
      slug: "retrieval-notes",
      title: "Retrieval notes",
      body: SOURCE,
      candidates: [
        { page: "sessions/2026-09/claude-code-aaa.md", stem: "claude-code-aaa", score: 0.9 },
        { page: "sessions/2026-09/codex-bbb.md", stem: "codex-bbb", score: 0.8 },
        { page: "wiki/rrf.md", stem: "rrf", score: 0.6 },
      ],
      pageStems: new Set(["source-claude-code-aaa", "rrf"]),
      vaultTags: [],
      now: NOW,
    });
    expect(s.related).toEqual(["source-claude-code-aaa", "rrf"]);
    expect(s.content).toContain("- [[source-claude-code-aaa]]");
    expect(s.content).not.toContain("[[claude-code-aaa]]");
    expect(s.content).not.toContain("codex-bbb");
  });

  it("says on the page itself that no model read the source", () => {
    expect(summary.content).toContain("No model read this source");
    expect(summary.content).toContain("raw/retrieval-notes.md");
  });

  it("stays valid for an empty source (no claims, still parseable)", () => {
    const empty = extractiveSummary(t, {
      slug: "empty",
      title: "Empty",
      body: "_(empty)_",
      candidates: [],
      vaultTags: [],
      now: NOW,
    });
    expect(empty.passages).toEqual([]);
    expect(empty.content).toContain("confidence: low");
    expect(empty.content).toContain("[^src-empty]: [[source-empty]]");
  });
});

describe("index / log / report", () => {
  it("appends the catalog line under an existing ## Sources", () => {
    const index = "# Index\n\n## Sources\n\n- [[source-old]] — Old\n\n## Concepts\n";
    const next = appendIndexEntry(index, "new-one", "New One");
    expect(next).toContain("## Sources\n\n- [[source-new-one]] — New One\n- [[source-old]] — Old");
    expect(next).toContain("## Concepts");
  });

  it("creates ## Sources when the index has none, and is idempotent", () => {
    const once = appendIndexEntry("# Index\n", "a", "A");
    expect(once).toContain("## Sources\n\n- [[source-a]] — A\n");
    expect(appendIndexEntry(once, "a", "A")).toBe(once);
  });

  it("retargets a legacy catalog link without replacing its human-edited label", () => {
    const current = "# Index\n\n## Sources\n\n- [[source-a]] — Human label\n";
    const next = appendIndexEntry(current, "a", "New generated label", "Old generated label", "wiki/older/source-a");
    expect(next).toContain("- [[wiki/older/source-a]] — Human label");
    expect(next).not.toContain("[[source-a]]");
    expect(appendIndexEntry(next, "a", "New generated label", "Old generated label", "wiki/older/source-a")).toBe(next);
  });

  it("appends the log line chronologically at the end", () => {
    expect(appendLogEntry("# Log\n", "- entry")).toBe("# Log\n\n- entry\n");
  });

  it("names the report <date>-<time>-<slug>.md so startIngest can find it", () => {
    const rel = reportRel("my-slug", NOW);
    expect(rel).toBe("ingest-reports/2026-09-06-140309-my-slug.md");
    expect(rel.endsWith("-my-slug.md")).toBe(true);
  });

  it("states plainly that the run made no model call", () => {
    const summary = extractiveSummary(t, {
      slug: "s",
      title: "T",
      body: SOURCE,
      candidates: [],
      vaultTags: [],
      now: NOW,
    });
    const report = extractiveReport(t, { slug: "s", title: "T", summary, now: NOW });
    expect(report).toContain("**No model was called.**");
    expect(report).toContain("- confidence: low");
    expect(report).toContain("`raw/s.md`");
  });
});

describe("runExtractiveIngest", () => {
  function io(existing: Record<string, string> = {}): {
    io: ExtractiveIngestIO;
    files: Record<string, string>;
  } {
    const files: Record<string, string> = { ...existing };
    const writeFile = vi.fn(async (path: string, content: string) => { files[path] = content; });
    return {
      files,
      io: {
        readFile: vi.fn(async (path: string) => {
          if (!(path in files)) throw new Error(`no such file: ${path}`);
          return { raw: files[path] };
        }),
        writeFile,
        writeFileIfUnchanged: vi.fn(async (path: string, content: string, expected: string | null) => {
          const current = path in files ? await sha256(files[path]) : null;
          if (current !== expected) throw new Error("write conflict: file changed before save");
          await writeFile(path, content);
        }),
        createFolder: vi.fn(async () => undefined),
      },
    };
  }

  const args = {
    vaultPath: "/v",
    slug: "retrieval-notes",
    title: "Retrieval notes",
    body: SOURCE,
    candidates: [{ page: "wiki/rrf.md", stem: "rrf", score: 0.6 }],
    vaultTags: ["retrieval"],
    now: NOW,
  };

  it("links the exact canonical summary when its name has no source prefix", async () => {
    const { io: fake, files } = io();
    const run = { ...args, slug: "renamed-summary", sessionKey: "codex:synthetic",
      summaryPath: "wiki/older/renamed-summary.md", source: "conversations/codex/synthetic", title: "Initial work" };
    const first = await runExtractiveIngest(fake, t, run);
    files[`/v/${first.summary.rel}`] += "\nHuman annotation remains.\n";
    const result = await runExtractiveIngest(fake, t, { ...run, source: "conversations/codex/synthetic.r1", title: "Updated work" });
    const target = "wiki/older/renamed-summary";
    expect(result.summary.rel).toBe(run.summaryPath);
    expect(result.summary.content).toContain("Human annotation remains.");
    expect(result.summary.content).toMatch(/\[\^src-[^\]]+\]: raw\/conversations\/codex\/synthetic\.r1\.md · \[\[wiki\/older\/renamed-summary\]\]/);
    expect(files["/v/wiki/index.md"].match(/\[\[wiki\/older\/renamed-summary\]\]/g)).toHaveLength(1);
    expect(files["/v/wiki/index.md"]).toContain("Updated work");
    expect(files["/v/wiki/log.md"]).toContain(`[[${target}]]`);
    expect(files[`/v/${result.written[3]}`]).toContain(`- summary: \`${run.summaryPath}\``);
    expect(Object.values(files).join("\n")).not.toContain("[[source-renamed-summary]]");
    expect(resolveStem([{ name: "wiki", path: "/v/wiki", kind: "directory", children: [
      { name: "older", path: "/v/wiki/older", kind: "directory", children: [
        { name: "renamed-summary.md", path: "/v/wiki/older/renamed-summary.md", kind: "file" },
      ] },
      { name: "renamed-summary.md", path: "/v/wiki/renamed-summary.md", kind: "file" },
    ] }], target)).toBe(`/v/${run.summaryPath}`);
  });

  it("updates one session title and cites each immutable revision without replacing annotations", async () => {
    const { io: fake, files } = io();
    const slug = "session-codex-synthetic";
    const first = await runExtractiveIngest(fake, t, { ...args, slug, sessionKey: "codex:synthetic",
      source: "conversations/codex/synthetic", title: "Initial search work" });
    const path = `/v/${first.summary.rel}`;
    files[path] += "\nHuman annotation remains.\n";
    const second = await runExtractiveIngest(fake, t, { ...args, slug, sessionKey: "codex:synthetic",
      source: "conversations/codex/synthetic.r1", title: "Search results and source opening", body: SOURCE + "\nNew synthetic source-opening result." });
    expect(second.summary.rel).toBe(first.summary.rel);
    expect(second.summary.content).toContain('title: "Source: Search results and source opening"');
    expect(second.summary.content).toContain("Human annotation remains.");
    expect(second.summary.content).toContain("raw/conversations/codex/synthetic.md");
    expect(second.summary.content).toContain("raw/conversations/codex/synthetic.r1.md");
    expect(second.summary.content.match(/^\[\^src-session-codex-synthetic-[a-f0-9]+\]:/gm)).toHaveLength(2);
    expect(files["/v/wiki/index.md"].match(/\[\[source-session-codex-synthetic\]\]/g)).toHaveLength(1);
    expect(files["/v/wiki/index.md"]).toContain("Search results and source opening");
    expect(Object.keys(files).filter(key => key.startsWith("/v/wiki/source-"))).toHaveLength(1);
  });

  it("preserves a session title changed by the user during later revisions", async () => {
    const { io: fake, files } = io();
    const run = { ...args, slug: "session-codex-synthetic", sessionKey: "codex:synthetic", title: "Original session title" };
    const first = await runExtractiveIngest(fake, t, run);
    files[`/v/${first.summary.rel}`] = first.summary.content.replace('title: "Source: Original session title"', "title: Human title");
    const next = await runExtractiveIngest(fake, t, { ...run, title: "Updated generated title", body: SOURCE + "\nSynthetic update." });
    expect(next.summary.content).toContain("title: Human title");
    expect(next.summary.content).not.toMatch(/^title: "Source: Updated generated title"$/m);
  });

  it("keeps new original record dates discoverable after updating an organized session", async () => {
    const { io: fake, files } = io();
    const summaryPath = "wiki/sources/session-codex-synthetic.md";
    const owned = "<!-- myco:codex-session-summary:start -->\nOriginal organized evidence.\n<!-- myco:codex-session-summary:end -->";
    files[`/v/${summaryPath}`] = `---\ntitle: Human session title\ntype: source-summary\nsession_key: codex:synthetic\nsession_kind: work\nsession_record_start: 2026-10-02\nsession_record_end: 2026-10-03\nsession_activity_days: [2026-10-03]\n---\n\n${owned}\n\nHuman annotation remains.\n`;
    const body = '---\nsource: codex\nconversation_id: synthetic\ncreated: 2026-10-06\nturn_metadata: [{"timestamp":"2026-10-07T09:00:00Z","original_role":"user"}]\n---\n\n**User:**\n\nPlease add the synthetic source-opening button.\n';
    const next = await runExtractiveIngest(fake, t, { ...args, summaryPath, sessionKey: "codex:synthetic",
      source: "conversations/codex/synthetic.r1", body, now: new Date("2026-10-08T12:00:00Z") });
    expect(next.summary.content).toContain("session_record_start: 2026-10-02");
    expect(next.summary.content).toContain("session_record_end: 2026-10-06");
    expect(next.summary.content).toContain("  - 2026-10-03\n  - 2026-10-07");
    expect(next.summary.content).not.toContain("  - 2026-10-08");
    expect(next.summary.content).toContain(owned);
    expect(next.summary.content).toContain("Human annotation remains.");
    expect(next.summary.content).toContain("title: Human session title");
  });

  it("summarizes the saved raw revision while preserving all 48 evidence chunks and deterministic links", async () => {
    const raw = "# Saved raw heading\n\n" + Array.from({ length: 48 }, (_, i) =>
      `**User:**\n\nSaved retrieval statement ${i} is a proposed change, not proof of completion.`).join("\n\n");
    const rawPath = "/v/raw/retrieval-notes.md";
    const { io: fake, files } = io({ [rawPath]: raw });
    const source = sourceEvidence("raw/retrieval-notes.md", raw, "2026-09-06");
    vi.mocked(ipc.localTransform).mockImplementation(async request => ({ answer: "The source proposes retrieval changes. [[raw/retrieval-notes]]",
      model_id: BUILTIN_CHAT_MODEL, used_sources: ["raw/retrieval-notes.md"], selected_chunks: request.sources.length }));
    const result = await runExtractiveIngest(fake, t, { ...args, body: "Unsaved pasted body differs.", localModelId: BUILTIN_CHAT_MODEL });
    expect(ipc.localTransform).toHaveBeenCalledOnce();
    expect(ipc.localTransform).toHaveBeenCalledWith(expect.objectContaining({ kind: "ingest", expectedVault: "/v", modelId: BUILTIN_CHAT_MODEL,
      sources: source.chunks.slice(0, 6).map(chunk => ({ page: chunk.source, revision: source.revision, text: chunk.text })) }));
    expect(result.chunksProcessed).toBe(48);
    expect(source.chunks).toHaveLength(49);
    expect(result.chunksPending).toBe(1);
    expect(result.summary.content).toContain("The source proposes retrieval changes.");
    expect(result.summary.content).toContain("Local preview from 6/48 chunks");
    expect(result.summary.content).toContain(BUILTIN_CHAT_MODEL);
    expect(result.summary.content).toContain("confidence: low");
    expect(result.summary.content).toContain("Saved retrieval statement 46");
    expect(result.summary.content).not.toContain("Unsaved pasted body differs");
    expect(result.summary.related).toEqual(["rrf"]);
    expect(result.summary.tags).toEqual(["retrieval"]);
    expect(files[rawPath]).toBe(raw);
    expect(vi.mocked(fake.writeFile).mock.calls.every(([path]) => !path.startsWith("/v/raw/"))).toBe(true);
    expect(files[`/v/${result.written[3]}`]).not.toContain("No model was called");
    expect(files["/v/wiki/log.md"]).not.toContain("no model call");
    expect(result.summary.content).not.toContain("No model read this source");
    const resumed = await runExtractiveIngest(fake, t, { ...args, localModelId: BUILTIN_CHAT_MODEL });
    expect(resumed.chunksPending).toBe(0);
    expect(resumed.chunksProcessed).toBe(1);
    expect(resumed.summary.content).toContain("Saved retrieval statement 47");
    expect(ipc.localTransform).toHaveBeenCalledTimes(2);
    await runExtractiveIngest(fake, t, { ...args, localModelId: BUILTIN_CHAT_MODEL });
    expect(ipc.localTransform).toHaveBeenCalledTimes(2);
  });

  it("keeps selected local model failures retryable without publishing coverage", async () => {
    const { io: fake, files } = io({ "/v/raw/retrieval-notes.md": SOURCE });
    vi.mocked(ipc.localTransform).mockResolvedValue({ answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "model_missing" });
    await expect(runExtractiveIngest(fake, t, { ...args, localModelId: BUILTIN_CHAT_MODEL }))
      .rejects.toMatchObject({ status: "pending", code: "model_missing" });
    expect(ipc.localTransform).toHaveBeenCalledOnce();
    expect(fake.writeFile).not.toHaveBeenCalled();
    expect(fake.writeFileIfUnchanged).not.toHaveBeenCalled();
    expect(fake.createFolder).not.toHaveBeenCalled();
    expect(files["/v/raw/retrieval-notes.md"]).toBe(SOURCE);
  });

  it("retries the same raw revision after the selected model becomes available", async () => {
    const { io: fake, files } = io({ "/v/raw/retrieval-notes.md": SOURCE });
    vi.mocked(ipc.localTransform).mockResolvedValueOnce({ answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "model_missing" })
      .mockResolvedValueOnce({ answer: "The source proposes synthetic retrieval improvements. [[raw/retrieval-notes]]", model_id: BUILTIN_CHAT_MODEL,
        used_sources: ["raw/retrieval-notes.md"], selected_chunks: 1 });
    await expect(runExtractiveIngest(fake, t, { ...args, localModelId: BUILTIN_CHAT_MODEL })).rejects.toMatchObject({ status: "pending" });
    const resumed = await runExtractiveIngest(fake, t, { ...args, localModelId: BUILTIN_CHAT_MODEL });
    expect(ipc.localTransform).toHaveBeenCalledTimes(2);
    expect(resumed.localPreview?.text).toContain("synthetic retrieval improvements");
    expect(resumed.chunksPending).toBe(0);
    expect(files["/v/raw/retrieval-notes.md"]).toBe(SOURCE);
    expect(resumed.summary.content.match(/myco:evidence-coverage/g)).toHaveLength(1);
  });

  it.each(["source_verification_failed", "source_changed_during_generation"])("does not write rejected source evidence: %s", async reason => {
    const { io: fake } = io({ "/v/raw/retrieval-notes.md": SOURCE });
    vi.mocked(ipc.localTransform).mockResolvedValue({ answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: reason });
    await expect(runExtractiveIngest(fake, t, { ...args, localModelId: BUILTIN_CHAT_MODEL })).rejects.toThrow("sources could not be verified");
    expect(fake.writeFile).not.toHaveBeenCalled();
    expect(fake.writeFileIfUnchanged).not.toHaveBeenCalled();
    expect(fake.createFolder).not.toHaveBeenCalled();
  });

  it("does not write stale quotes if raw changes while an unavailable model returns", async () => {
    const { io: fake, files } = io({ "/v/raw/retrieval-notes.md": SOURCE });
    vi.mocked(ipc.localTransform).mockImplementation(async () => {
      files["/v/raw/retrieval-notes.md"] += "\nExternal source revision.";
      return { answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "model_missing" };
    });
    await expect(runExtractiveIngest(fake, t, { ...args, localModelId: BUILTIN_CHAT_MODEL })).rejects.toThrow("sources could not be verified");
    expect(fake.writeFile).not.toHaveBeenCalled();
    expect(fake.writeFileIfUnchanged).not.toHaveBeenCalled();
  });

  it("writes exactly the wiki/report file set the LLM path writes", async () => {
    const { io: fake } = io();
    const { written } = await runExtractiveIngest(fake, t, args);
    // raw/<slug>.md is startIngest's writeRaw, not this module's — everything
    // else INGEST_PROMPT asks the LLM for is here.
    expect(written).toEqual([
      "wiki/source-retrieval-notes.md",
      "wiki/index.md",
      "wiki/log.md",
      "ingest-reports/2026-09-06-140309-retrieval-notes.md",
    ]);
  });

  it("grows an existing index and log instead of replacing them", async () => {
    const { io: fake, files } = io({
      "/v/wiki/index.md": "# Index\n\n## Sources\n\n- [[source-old]] — Old\n",
      "/v/wiki/log.md": "# Log\n\n- 2026-01-01 — something earlier\n",
    });
    await runExtractiveIngest(fake, t, args);
    expect(files["/v/wiki/index.md"]).toContain("- [[source-old]] — Old");
    expect(files["/v/wiki/index.md"]).toContain("- [[source-retrieval-notes]] — Retrieval notes");
    expect(files["/v/wiki/log.md"]).toContain("- 2026-01-01 — something earlier");
    expect(files["/v/wiki/log.md"]).toContain("[[source-retrieval-notes]]");
    expect(files["/v/wiki/log.md"]).toContain("no model call");
  });

  it("resumes bounded evidence through the tail and preserves hand edits", async () => {
    const body = "A synthetic source statement. ".repeat(1_100) + " Tail decision SYN-4719 was cancelled.";
    const nextArgs = { ...args, body };
    const { io: fake, files } = io();
    const first = await runExtractiveIngest(fake, t, nextArgs);
    const total = sourceEvidence("raw/retrieval-notes.md", body, "2026-09-06").chunks.length;
    expect(first.chunksProcessed).toBe(48);
    expect(first.chunksPending).toBe(total - 48);
    const key = "/v/wiki/source-retrieval-notes.md";
    files[key] = "Human annotation retained.\n" + files[key];
    const second = await runExtractiveIngest(fake, t, nextArgs);
    expect(second.chunksPending).toBe(0);
    expect(second.summary.content).toContain("Tail decision SYN-4719 was cancelled.");
    expect(second.summary.content.startsWith("Human annotation retained.")).toBe(true);
    expect(second.chunksProcessed).toBe(total - 48);
    expect(Object.keys(files).some((path) => path.startsWith("/v/raw/"))).toBe(false);
  });

  it("refuses to overwrite an unreadable existing summary", async () => {
    const { io: fake } = io();
    vi.mocked(fake.readFile).mockRejectedValue(new Error("permission denied"));
    await expect(runExtractiveIngest(fake, t, args)).rejects.toThrow("permission denied");
    expect(fake.writeFile).not.toHaveBeenCalled();
  });

  it("rebuilds a conflicted summary append from the user's latest edit", async () => {
    const key = "/v/wiki/source-retrieval-notes.md";
    const { io: fake, files } = io({ [key]: "Original annotation.\n" });
    const guarded = vi.mocked(fake.writeFileIfUnchanged).getMockImplementation()!;
    vi.mocked(fake.writeFileIfUnchanged).mockImplementationOnce(async () => {
      files[key] += "Concurrent human annotation.\n";
      throw new Error("write conflict: file changed before save");
    }).mockImplementation(guarded);
    const result = await runExtractiveIngest(fake, t, args);
    expect(result.summary.content).toContain("Concurrent human annotation.");
    expect(result.chunksPending).toBe(0);
    expect(files[key]).toBe(result.summary.content);
  });

  it("propagates folder permission errors before writing evidence", async () => {
    const { io: fake } = io();
    vi.mocked(fake.createFolder).mockRejectedValue(new Error("permission denied"));
    await expect(runExtractiveIngest(fake, t, args)).rejects.toThrow("permission denied");
    expect(fake.writeFile).not.toHaveBeenCalled();
  });

  it("titles a session transcript by its first heading, agent and date", async () => {
    const created = Date.UTC(2026, 6, 27, 12) / 1000; // 2026-07-27 in ±11h
    const slug = "claude-code-064ddbe4-251d-4da1-8315-da096a5b75ff";
    const body =
      `---\nsource: claude-code\nconversation_id: 064ddbe4-251d-4da1-8315-da096a5b75ff\n` +
      `created: ${created}\n---\n\n# 서버 띄워봐.\n\n**User:**\n\n서버 띄워봐.\n`;
    const { io: fake, files } = io();
    const { summary } = await runExtractiveIngest(fake, t, { ...args, slug, title: slug, body });
    const readable = "서버 띄워봐. · Claude Code · 2026-07-27";
    expect(summary.content).toContain(`title: "Source: ${readable}"`);
    expect(summary.content).toContain(`# Source: ${readable}\n`);
    expect(files["/v/wiki/index.md"]).toContain(`- [[source-${slug}]] — ${readable}`);
    // The slug stays the identity: raw path, citation, file name.
    expect(summary.rel).toBe(`wiki/source-${slug}.md`);
    expect(summary.content).toContain(`[^src-${slug}]: [[source-${slug}]]`);
  });

  it("keeps `$` sequences in a session's first prompt verbatim in the log and report", async () => {
    const created = Date.UTC(2026, 6, 27, 12) / 1000;
    const slug = "claude-code-064ddbe4-251d-4da1-8315-da096a5b75ff";
    const ask = "printf $'a\\tb' 가 왜 $& 로 보여? $$ $`";
    const body =
      `---\nsource: claude-code\nconversation_id: 064ddbe4-251d-4da1-8315-da096a5b75ff\n` +
      `created: ${created}\n---\n\n# ${ask}\n\n**User:**\n\n${ask}\n`;
    const { io: fake, files } = io();
    const { written } = await runExtractiveIngest(fake, t, { ...args, slug, title: slug, body });
    const readable = `${ask} · Claude Code · 2026-07-27`;
    expect(files["/v/wiki/log.md"]).toContain(`(${readable})`);
    const report = files[`/v/${written[3]}`];
    expect(report.startsWith(`# ${t.ing_extractive_report_title.split("{title}")[0]}${readable}`)).toBe(
      true,
    );
  });

  it("still writes the full set into a vault with no index/log yet", async () => {
    const { io: fake, files } = io();
    await runExtractiveIngest(fake, t, args);
    expect(files["/v/wiki/index.md"]).toContain("# Index");
    expect(files["/v/wiki/log.md"]).toContain("# Log");
  });
});
