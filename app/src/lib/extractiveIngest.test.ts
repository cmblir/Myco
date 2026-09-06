// Offline ingest must produce a page the project's own validator accepts and
// a page that never says anything the source did not. Both are asserted here
// against the frontmatter contract in `src-tauri/src/validator.rs`
// (validate_pages) and `src-tauri/src/vault.rs`'s VAULT_CLAUDE_MD.

import { describe, expect, it, vi } from "vitest";
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

const t = STRINGS.en;
const NOW = new Date(2026, 8, 6, 14, 3, 9); // 2026-09-06 14:03:09 local

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
    return {
      files,
      io: {
        readFile: vi.fn(async (path: string) => {
          if (!(path in files)) throw new Error(`no such file: ${path}`);
          return { raw: files[path] };
        }),
        writeFile: vi.fn(async (path: string, content: string) => {
          files[path] = content;
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

  it("still writes the full set into a vault with no index/log yet", async () => {
    const { io: fake, files } = io();
    await runExtractiveIngest(fake, t, args);
    expect(files["/v/wiki/index.md"]).toContain("# Index");
    expect(files["/v/wiki/log.md"]).toContain("# Log");
  });
});
