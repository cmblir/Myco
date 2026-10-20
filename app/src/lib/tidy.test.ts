import { describe, expect, it } from "vitest";
import { planTidy, tidyEdits, type TidyFile, type TidyInput } from "./tidy";
import {
  applyTidy,
  lastTidy,
  scanTidy,
  undoTidy,
  type TidyFs,
} from "./tidyRun";

// Noon UTC, so the local calendar day is 2026-09-20 in any timezone within ±11h.
const CREATED = Date.UTC(2026, 8, 20, 12) / 1000;
const A = "claude-code-3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
const B = "codex-019e2b7c-4d1a-7c3e-9f5b-2a8d6c4e1f07";
const LOST = "claude-code-e4649b3c-c5ca-4d83-a0a7-e2f41c540fe6";

function transcript(stem: string, ask: string): TidyFile {
  const [, source, id] = /^(claude-code|codex)-(.+)$/.exec(stem) ?? [];
  return {
    path: `sessions/2026-09/${stem}.md`,
    raw:
      `---\nsource: ${source}\nconversation_id: ${id}\ncreated: ${CREATED}\n---\n\n` +
      `# ${ask}\n\n**User:**\n\n${ask}\n`,
  };
}

/** The page the pre-fix extractive ingest wrote of a session. */
function summary(stem: string, related: string[], prose = ""): TidyFile {
  return {
    path: `wiki/source-${stem}.md`,
    raw:
      `---\ntitle: "Source: ${stem}"\ntype: source-summary\ncreated: 2026-09-20\n---\n\n` +
      `# Source: ${stem}\n\n- A quoted line. [^src-${stem}]\n${prose}\n## Related\n\n` +
      related.map((r) => `- [[${r}]]\n`).join("") +
      `\n[^src-${stem}]: [[source-${stem}]]\n`,
  };
}

const page = (input: TidyInput, path: string): string =>
  input.pages.find((p) => p.path === path)?.raw ?? "";

describe("planTidy", () => {
  it("titles an opaque page by its transcript's first prompt, agent and date", () => {
    const input = {
      pages: [summary(A, [])],
      transcripts: [transcript(A, "서버 띄워봐.")],
    };
    const plan = planTidy(input);
    expect(plan.groups.map((g) => g.key)).toEqual(["titles", "move"]);
    expect(plan.groups[0].rows).toEqual([
      {
        path: `wiki/source-${A}.md`,
        before: `Source: ${A}`,
        after: "서버 띄워봐. · Claude Code · 2026-09-20",
      },
    ]);
    const [edit] = tidyEdits(input, new Set(["titles"]));
    expect(edit.to).toBe(edit.path);
    expect(edit.after).toBe(
      page(input, edit.path)
        .replace(
          `title: "Source: ${A}"`,
          'title: "서버 띄워봐. · Claude Code · 2026-09-20"',
        )
        .replace(`# Source: ${A}`, "# 서버 띄워봐. · Claude Code · 2026-09-20"),
    );
  });

  it("finds a transcript by conversation_id under raw/, ingest's `# <stem>` line included", () => {
    const moved = transcript(A, "서버 띄워봐.");
    const raw = {
      path: `raw/archive/2026-09/renamed.md`,
      raw: `# ${A}\n\n${moved.raw}`,
    };
    const plan = planTidy({ pages: [summary(A, [])], transcripts: [raw] });
    expect(plan.groups[0].rows[0].after).toBe(
      "서버 띄워봐. · Claude Code · 2026-09-20",
    );
  });

  it("points a Related link at the session's summary, drops one with none", () => {
    const input = {
      pages: [
        summary(
          A,
          [B, LOST, "attention-mechanism"],
          `See [[${LOST}]] in prose.\n`,
        ),
        summary(B, []),
      ],
      transcripts: [],
    };
    const plan = planTidy(input);
    const links = plan.groups.find((g) => g.key === "links");
    expect(links?.rows).toEqual([
      {
        path: `wiki/source-${A}.md`,
        before: `[[${B}]]`,
        after: `[[source-${B}]]`,
      },
      { path: `wiki/source-${A}.md`, before: `[[${LOST}]]`, after: null },
    ]);
    const [edit] = tidyEdits(input, new Set(["links"]));
    expect(edit.after).toContain(
      `- [[source-${B}]]\n- [[attention-mechanism]]\n`,
    );
    expect(edit.after).not.toContain(`- [[${LOST}]]`);
    // Prose and citations are never touched.
    expect(edit.after).toContain(`See [[${LOST}]] in prose.`);
    expect(edit.after).toContain(`[^src-${A}]: [[source-${A}]]`);
  });

  it("touches only the transcript links on a bullet that holds several", () => {
    const withRelated = (lines: string): TidyFile => {
      const p = summary(A, ["X"]);
      return { ...p, raw: p.raw.replace("- [[X]]\n", lines) };
    };
    const concept: TidyFile = {
      path: "wiki/attention-mechanism.md",
      raw: "# Attention\n",
    };
    const input = {
      pages: [
        withRelated(
          `- [[${LOST}]] · [[attention-mechanism]]\n` +
            `- [[attention-mechanism]], [[${B}]]\n` +
            `- [[${B}|the codex run]] and [[${LOST}#Plan]]\n`,
        ),
        summary(B, []),
        concept,
      ],
      transcripts: [],
    };
    const links = planTidy(input).groups.find((g) => g.key === "links");
    expect(links?.rows.map((r) => [r.before, r.after])).toEqual([
      [`[[${LOST}]]`, null],
      [`[[${B}]]`, `[[source-${B}]]`],
      [`[[${B}]]`, `[[source-${B}]]`],
      [`[[${LOST}]]`, null],
    ]);
    const [edit] = tidyEdits(input, new Set(["links"]));
    expect(edit.after).toContain(
      "## Related\n\n" +
        "- [[attention-mechanism]]\n" +
        `- [[attention-mechanism]], [[source-${B}]]\n` +
        `- [[source-${B}|the codex run]] and\n`,
    );
  });

  it("skips (and names) an opaque page with no transcript", () => {
    const plan = planTidy({ pages: [summary(A, [])], transcripts: [] });
    expect(plan.groups.find((g) => g.key === "titles")).toBeUndefined();
    expect(plan.skipped).toEqual([`wiki/source-${A}.md`]);
  });

  it("proposes nothing for a vault that is already tidy", () => {
    const tidy: TidyFile = {
      path: `wiki/sessions/2026-09/source-${A}.md`,
      raw:
        `---\ntitle: "서버 띄워봐. · Claude Code · 2026-09-20"\ncreated: 2026-09-20\n---\n\n` +
        `# 서버 띄워봐. · Claude Code · 2026-09-20\n\n## Related\n\n- [[source-${B}]]\n`,
    };
    const input = {
      pages: [tidy],
      transcripts: [transcript(A, "서버 띄워봐.")],
    };
    expect(planTidy(input)).toEqual({ groups: [], skipped: [] });
    expect(tidyEdits(input, new Set(["titles", "links", "move"]))).toEqual([]);
  });

  it("moves a session summary under wiki/sessions/<created month>/, composed with its rewrites", () => {
    const input = {
      pages: [summary(A, [LOST])],
      transcripts: [transcript(A, "서버 띄워봐.")],
    };
    const plan = planTidy(input);
    expect(plan.groups.find((g) => g.key === "move")?.rows).toEqual([
      {
        path: `wiki/source-${A}.md`,
        before: `wiki/source-${A}.md`,
        after: `wiki/sessions/2026-09/source-${A}.md`,
      },
    ]);
    const [edit] = tidyEdits(input, new Set(["titles", "links", "move"]));
    expect(edit.to).toBe(`wiki/sessions/2026-09/source-${A}.md`);
    expect(edit.after).toContain("# 서버 띄워봐. · Claude Code · 2026-09-20");
    expect(edit.after).not.toContain(`[[${LOST}]]`);
    // Unchecked groups leave the page alone.
    expect(tidyEdits(input, new Set())).toEqual([]);
  });

  it("never plans a write under raw/ or sessions/", () => {
    const stray = {
      ...summary(A, [LOST]),
      path: `sessions/2026-09/source-${A}.md`,
    };
    const raw = { ...summary(A, [LOST]), path: `raw/source-${A}.md` };
    const input = {
      pages: [stray, raw],
      transcripts: [transcript(A, "서버 띄워봐.")],
    };
    expect(planTidy(input)).toEqual({ groups: [], skipped: [] });
  });
});

/** A vault in a Map, with the one rule the backend adds: move_path refuses an
 *  existing target and a missing directory. */
function memFs(
  files: TidyFile[],
): TidyFs & { files: Map<string, string>; dirs: Set<string> } {
  const files_ = new Map(files.map((f) => [f.path, f.raw]));
  const dirs = new Set(
    files.flatMap((f) => [f.path.slice(0, f.path.lastIndexOf("/"))]),
  );
  return {
    files: files_,
    dirs,
    async read(path) {
      const raw = files_.get(path);
      if (raw === undefined) throw new Error(`not found: ${path}`);
      return raw;
    },
    async write(path, content) {
      if (path.startsWith("raw/"))
        throw new Error("refused: raw/ is immutable");
      files_.set(path, content);
    },
    async move(from, toDir) {
      const raw = files_.get(from);
      const to = `${toDir}/${from.slice(from.lastIndexOf("/") + 1)}`;
      if (raw === undefined) throw new Error(`not found: ${from}`);
      if (!dirs.has(toDir)) throw new Error(`not a directory: ${toDir}`);
      if (files_.has(to)) throw new Error(`destination exists: ${to}`);
      files_.delete(from);
      files_.set(to, raw);
    },
    async mkdirs(dir) {
      for (let i = dir.indexOf("/"); i > 0; i = dir.indexOf("/", i + 1))
        dirs.add(dir.slice(0, i));
      dirs.add(dir);
    },
  };
}

describe("applyTidy / undoTidy", () => {
  const NOW = new Date("2026-09-28T09:30:00.000Z");
  const vault = (): ReturnType<typeof memFs> =>
    memFs([
      summary(A, [B, LOST]),
      summary(B, [A]),
      transcript(A, "서버 띄워봐."),
      transcript(B, "범례"),
    ]);

  it("scans wiki pages and only the transcripts an opaque page names", async () => {
    const fs = vault();
    fs.files.set(
      "sessions/2026-09/claude-code-00000000-0000-4000-8000-000000000000.md",
      "x",
    );
    const input = await scanTidy(fs, [...fs.files.keys()]);
    expect(input.pages.map((p) => p.path).sort()).toEqual([
      `wiki/source-${A}.md`,
      `wiki/source-${B}.md`,
    ]);
    expect(input.transcripts.map((p) => p.path).sort()).toEqual([
      `sessions/2026-09/${A}.md`,
      `sessions/2026-09/${B}.md`,
    ]);
  });

  it("snapshots before writing, and undo restores every file byte for byte", async () => {
    const fs = vault();
    const original = new Map(fs.files);
    const input = await scanTidy(fs, [...fs.files.keys()]);
    const edits = tidyEdits(input, new Set(["titles", "links", "move"]));
    const receipt = await applyTidy(fs, edits, NOW);
    expect(receipt.failed).toEqual([]);
    expect(receipt.done.map((e) => e.to).sort()).toEqual([
      `wiki/sessions/2026-09/source-${A}.md`,
      `wiki/sessions/2026-09/source-${B}.md`,
    ]);
    expect(fs.files.has(`wiki/source-${A}.md`)).toBe(false);

    const last = await lastTidy(fs);
    expect(last?.path).toBe(receipt.snapshot);
    expect(receipt.snapshot).toMatch(
      /^\.myco\/tidy\/2026-09-28T09-30-00-000Z\.json$/,
    );
    const snap = JSON.parse(fs.files.get(receipt.snapshot) ?? "{}");
    expect(snap.files[0]).toMatchObject({
      path: `wiki/source-${A}.md`,
      before: original.get(`wiki/source-${A}.md`),
    });
    expect(snap.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);

    const undone = await undoTidy(fs, receipt.snapshot, NOW);
    expect(undone).toEqual({ restored: 2, skipped: [], failed: [] });
    for (const [path, raw] of original) expect(fs.files.get(path)).toBe(raw);
    expect(fs.files.has(`wiki/sessions/2026-09/source-${A}.md`)).toBe(false);
    expect((await lastTidy(fs))?.snapshot.undone).toBe(NOW.toISOString());
  });

  it("undo leaves (and names) a file edited since the run", async () => {
    const fs = vault();
    const input = await scanTidy(fs, [...fs.files.keys()]);
    const receipt = await applyTidy(
      fs,
      tidyEdits(input, new Set(["titles", "links"])),
      NOW,
    );
    const edited = `wiki/source-${B}.md`;
    const mine = `${fs.files.get(edited)}\nMy own line.\n`;
    fs.files.set(edited, mine);

    const undone = await undoTidy(fs, receipt.snapshot, NOW);
    expect(undone.restored).toBe(1);
    expect(undone.skipped).toEqual([edited]);
    expect(fs.files.get(edited)).toBe(mine);
    expect(fs.files.get(`wiki/source-${A}.md`)).toBe(summary(A, [B, LOST]).raw);
  });

  it("leaves (and names) a page written between the scan and apply, and undo cannot roll it back", async () => {
    const fs = vault();
    const input = await scanTidy(fs, [...fs.files.keys()]);
    const edits = tidyEdits(input, new Set(["titles", "links", "move"]));
    // The editor's 2 s autosave (or an MCP write) lands while the sheet is open.
    const typed = `wiki/source-${A}.md`;
    const mine = `${fs.files.get(typed)}\nTyped after the scan.\n`;
    fs.files.set(typed, mine);

    const receipt = await applyTidy(fs, edits, NOW);
    expect(receipt.changed).toEqual([typed]);
    expect(receipt.failed).toEqual([]);
    expect(receipt.done.map((e) => e.path)).toEqual([`wiki/source-${B}.md`]);
    expect(fs.files.get(typed)).toBe(mine);
    const snap = JSON.parse(fs.files.get(receipt.snapshot) ?? "{}");
    expect(snap.files.map((f: { path: string }) => f.path)).toEqual([
      `wiki/source-${B}.md`,
    ]);

    const undone = await undoTidy(fs, receipt.snapshot, NOW);
    expect(undone).toEqual({ restored: 1, skipped: [], failed: [] });
    expect(fs.files.get(typed)).toBe(mine);
  });

  it("reports a file it could not write and keeps going", async () => {
    const fs = vault();
    const input = await scanTidy(fs, [...fs.files.keys()]);
    const edits = tidyEdits(input, new Set(["titles", "move"]));
    fs.files.set(`wiki/sessions/2026-09/source-${B}.md`, "someone else's page");
    await fs.mkdirs("wiki/sessions/2026-09");
    const receipt = await applyTidy(fs, edits, NOW);
    // B's text was rewritten in place before its move was refused.
    expect(receipt.failed.map((f) => f.path)).toEqual([`wiki/source-${B}.md`]);
    expect(receipt.done.map((e) => e.to)).toEqual([
      `wiki/sessions/2026-09/source-${A}.md`,
      `wiki/source-${B}.md`,
    ]);
    const undone = await undoTidy(fs, receipt.snapshot, NOW);
    expect(undone).toEqual({ restored: 2, skipped: [], failed: [] });
    expect(fs.files.get(`wiki/source-${B}.md`)).toBe(summary(B, [A]).raw);
  });

  it("refuses to touch raw/ or sessions/ at all", async () => {
    const fs = vault();
    const before = new Map(fs.files);
    const bad = [
      {
        path: `sessions/2026-09/${A}.md`,
        to: `sessions/2026-09/${A}.md`,
        before: "",
        after: "x",
      },
    ];
    await expect(applyTidy(fs, bad, NOW)).rejects.toThrow(/sessions/);
    const moved = [
      {
        path: `wiki/source-${A}.md`,
        to: `raw/source-${A}.md`,
        before: "",
        after: "x",
      },
    ];
    await expect(applyTidy(fs, moved, NOW)).rejects.toThrow(/raw/);
    expect(fs.files).toEqual(before);
  });
});
