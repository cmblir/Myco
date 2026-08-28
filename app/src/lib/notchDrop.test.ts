import { describe, expect, it, vi } from "vitest";
import {
  classifyDrop,
  inboxFilename,
  inboxFrontmatter,
  writeDrop,
} from "./notchDrop";
import type { DropDeps } from "./notchDrop";

const NOW = new Date("2026-08-25T14:32:00");
const NOW_MS = NOW.getTime();

function deps(overrides: Partial<DropDeps> = {}): DropDeps {
  return {
    inboxNames: vi.fn(async () => []),
    copyFile: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    now: () => NOW_MS,
    ...overrides,
  };
}

describe("classifyDrop", () => {
  it("routes each supported file to the pipeline that can read it", () => {
    const v = classifyDrop({
      type: "files",
      paths: [
        "/u/notes/plan.md",
        "/u/papers/attention.pdf",
        "/u/shots/diagram.PNG",
        "/u/rec/standup.m4a",
      ],
    });
    expect(v.map((x) => x.kind)).toEqual(["md", "extract", "image", "media"]);
    expect(v.every((x) => x.reason === undefined)).toBe(true);
  });

  it("says WHY an unsupported file was refused, naming the format", () => {
    const [v] = classifyDrop({ type: "files", paths: ["/u/books/novel.epub"] });
    expect(v.kind).toBe("unsupported");
    // The S9 line is the only place the user learns this — never silent.
    expect(v.reason).toContain(".epub");
  });

  it("uses the localized reason when the surface passes one", () => {
    const [v] = classifyDrop(
      { type: "files", paths: ["/u/a.zip"] },
      "이 형식은 아직 읽지 못합니다 ({ext})",
    );
    expect(v.reason).toBe("이 형식은 아직 읽지 못합니다 (.zip)");
  });

  it("names an extensionless drop instead of showing empty parentheses", () => {
    const [v] = classifyDrop({ type: "files", paths: ["/u/some-folder"] });
    expect(v.reason).toContain("some-folder");
  });

  it("takes a link as-is and a selection by its opening words", () => {
    const [url] = classifyDrop({ type: "url", url: " https://x.com/a " });
    expect(url).toMatchObject({ kind: "url", source: "https://x.com/a" });
    const [text] = classifyDrop({
      type: "text",
      text: "\n\nfirst line\nsecond",
    });
    expect(text).toMatchObject({ kind: "text", title: "first line" });
  });

  it("has no verdict for an empty link or selection — nothing was dropped", () => {
    expect(classifyDrop({ type: "url", url: "   " })).toEqual([]);
    expect(classifyDrop({ type: "text", text: " \n " })).toEqual([]);
  });

  it("keeps a Korean filename readable as the title", () => {
    const [v] = classifyDrop({
      type: "files",
      paths: ["/u/문서/회의록 정리.pdf"],
    });
    expect(v).toMatchObject({ kind: "extract", title: "회의록 정리.pdf" });
  });
});

describe("inboxFilename", () => {
  it("keeps a file's own name and extension, Hangul included", () => {
    expect(inboxFilename("extract", "회의록 정리.pdf", NOW)).toBe(
      "회의록-정리.pdf",
    );
  });

  it("avoids a name already in _inbox — dropping the same file twice", () => {
    const first = inboxFilename("extract", "attention.pdf", NOW);
    const second = inboxFilename("extract", "attention.pdf", NOW, [first]);
    const third = inboxFilename("extract", "attention.pdf", NOW, [
      first,
      second,
    ]);
    expect([first, second, third]).toEqual([
      "attention.pdf",
      "attention-2.pdf",
      "attention-3.pdf",
    ]);
  });

  it("treats a taken name case-insensitively — the vault's filesystem does", () => {
    expect(inboxFilename("extract", "Paper.PDF", NOW, ["PAPER.pdf"])).toBe(
      "paper-2.pdf",
    );
  });

  it("turns a link into a drop-<host>.md note", () => {
    expect(inboxFilename("url", "https://www.arxiv.org/abs/1706", NOW)).toBe(
      "drop-arxiv-org-abs-1706.md",
    );
  });

  it("falls back to the timestamp when nothing sluggable is left", () => {
    expect(inboxFilename("text", "!!! ???", NOW)).toBe(
      "drop-2026-08-25-1432.md",
    );
  });
});

describe("inboxFrontmatter", () => {
  it("writes clip.rs's spine: quoted strings, created as a unix integer", () => {
    const fm = inboxFrontmatter({
      title: "Attention: all you need",
      url: "https://arxiv.org/abs/1706.03762",
      created: 1_700_000_000,
    });
    expect(fm).toBe(
      '---\nsource: drop\nurl: "https://arxiv.org/abs/1706.03762"\n' +
        'title: "Attention: all you need"\ncreated: 1700000000\n---\n\n',
    );
  });

  it("keeps a hostile title inside its scalar — quotes and newlines escaped", () => {
    const title = 'he said "hi"\n---\nsource: trusted';
    const fm = inboxFrontmatter({ title, created: 1 });
    const lines = fm.split("\n");
    // Exactly the opening and closing fences: the title never broke out.
    expect(lines.filter((l) => l === "---")).toHaveLength(2);
    const scalar = lines.find((l) => l.startsWith("title: "))?.slice(7);
    expect(scalar).toBeDefined();
    expect(JSON.parse(scalar as string)).toBe(title);
    expect(fm).not.toContain("source: trusted\n");
  });

  it("never renders a non-integer created", () => {
    expect(
      inboxFrontmatter({ title: "t", created: Number.NaN }),
    ).toContain("created: 0");
    expect(
      inboxFrontmatter({ title: "t", created: 1.9 }),
    ).toContain("created: 1");
  });
});

describe("writeDrop", () => {
  it("copies a dropped file into _inbox — the original stays put", async () => {
    const d = deps();
    const out = await writeDrop(
      "/v",
      { type: "files", paths: ["/u/papers/attention.pdf"] },
      d,
    );
    expect(d.copyFile).toHaveBeenCalledWith(
      "/u/papers/attention.pdf",
      "/v/_inbox/attention.pdf",
    );
    expect(d.writeFile).not.toHaveBeenCalled();
    expect(out).toEqual({
      written: ["/v/_inbox/attention.pdf"],
      rejected: [],
      failed: [],
    });
  });

  it("does not clobber a file of the same name already waiting", async () => {
    const d = deps({ inboxNames: vi.fn(async () => ["attention.pdf"]) });
    const out = await writeDrop(
      "/v",
      { type: "files", paths: ["/u/attention.pdf"] },
      d,
    );
    expect(out.written).toEqual(["/v/_inbox/attention-2.pdf"]);
  });

  it("keeps two same-named files of ONE drop apart", async () => {
    const d = deps();
    const out = await writeDrop(
      "/v",
      { type: "files", paths: ["/a/notes.md", "/b/notes.md"] },
      d,
    );
    expect(out.written).toEqual(["/v/_inbox/notes.md", "/v/_inbox/notes-2.md"]);
  });

  it("writes a link as a markdown note carrying its url", async () => {
    const d = deps();
    const out = await writeDrop(
      "/v",
      { type: "url", url: "https://arxiv.org/abs/1706.03762" },
      d,
    );
    const [path, body] = vi.mocked(d.writeFile).mock.calls[0];
    expect(path).toBe(out.written[0]);
    expect(body).toContain('url: "https://arxiv.org/abs/1706.03762"');
    expect(body).toContain("source: drop");
    expect(body).toContain(`created: ${Math.floor(NOW_MS / 1000)}`);
    expect(body).toContain("Source: https://arxiv.org/abs/1706.03762");
    expect(d.copyFile).not.toHaveBeenCalled();
  });

  it("writes a Korean selection as a quoted note", async () => {
    const d = deps();
    await writeDrop("/v", { type: "text", text: "회의 결정\n두 번째 줄" }, d);
    const [path, body] = vi.mocked(d.writeFile).mock.calls[0];
    expect(path).toBe("/v/_inbox/drop-회의-결정.md");
    expect(body).toContain('title: "회의 결정"');
    expect(body).toContain("> 회의 결정\n> 두 번째 줄\n");
  });

  it("writes NOTHING when nothing readable was dropped", async () => {
    const d = deps();
    const out = await writeDrop(
      "/v",
      { type: "files", paths: ["/u/a.epub", "/u/b.zip"] },
      d,
    );
    expect(d.copyFile).not.toHaveBeenCalled();
    expect(d.writeFile).not.toHaveBeenCalled();
    expect(d.inboxNames).not.toHaveBeenCalled();
    expect(out.written).toEqual([]);
    expect(out.rejected.map((r) => r.reason)).toEqual([
      expect.stringContaining(".epub"),
      expect.stringContaining(".zip"),
    ]);
  });

  it("takes the readable half of a mixed drop and refuses the rest", async () => {
    const d = deps();
    const out = await writeDrop(
      "/v",
      { type: "files", paths: ["/u/a.epub", "/u/plan.md"] },
      d,
    );
    expect(out.written).toEqual(["/v/_inbox/plan.md"]);
    expect(out.rejected).toHaveLength(1);
  });
});

describe("a failing item does not take the rest of the drop with it", () => {
  it("keeps going and reports what failed", async () => {
    // Five files where one is unreadable used to land the first and abort,
    // leaving the user to guess which three never arrived.
    const copyFile = vi.fn(async (from: string) => {
      if (from.includes("locked")) throw new Error("permission denied");
      return undefined;
    });
    const out = await writeDrop(
      "/v",
      {
        type: "files",
        paths: ["/u/a.pdf", "/u/locked.pdf", "/u/c.pdf"],
      },
      {
        inboxNames: async () => [],
        copyFile,
        writeFile: vi.fn(),
        now: () => 0,
      },
    );
    expect(out.written).toEqual(["/v/_inbox/a.pdf", "/v/_inbox/c.pdf"]);
    expect(out.failed).toEqual([
      { title: "locked.pdf", error: "Error: permission denied" },
    ]);
    expect(copyFile).toHaveBeenCalledTimes(3);
  });

  it("reports nothing written when every acceptable item failed", async () => {
    const out = await writeDrop(
      "/v",
      { type: "files", paths: ["/u/a.pdf"] },
      {
        inboxNames: async () => [],
        copyFile: vi.fn(async () => {
          throw new Error("disk full");
        }),
        writeFile: vi.fn(),
        now: () => 0,
      },
    );
    expect(out.written).toEqual([]);
    expect(out.failed).toHaveLength(1);
  });
});
