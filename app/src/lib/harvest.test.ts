import { describe, expect, it, vi } from "vitest";
import type { HarvestCandidate, HarvestExcluded, ProvenanceRow } from "./ipc";
import type { InboxPassOutcome } from "./autoIngest";
import {
  EXCLUDED_ORDER,
  clusterColorVar,
  clusterLabel,
  distinctCitations,
  excludedRows,
  formatKb,
  harvestLabel,
  harvestSurface,
  harvestSelected,
  junkExcluded,
  queueProgress,
  selectionTotals,
} from "./harvest";

function cand(path: string, size_bytes: number, est_citations: number): HarvestCandidate {
  return {
    path,
    rel: path.replace("/v/", ""),
    size_bytes,
    mtime: 0,
    title: path,
    preview: [],
    cluster: null,
    est_citations,
    kind: "session",
  };
}

const ITEMS = [
  cand("/v/sessions/a.md", 42_000, 4),
  cand("/v/sessions/b.md", 18_000, 3),
  cand("/v/sessions/c.md", 96_000, 5),
];

describe("selectionTotals", () => {
  it("sums count, bytes and estimated citations over the selected paths only", () => {
    const sel = new Set(["/v/sessions/a.md", "/v/sessions/c.md"]);
    expect(selectionTotals(ITEMS, sel)).toEqual({
      count: 2,
      bytes: 138_000,
      citations: 9,
    });
  });

  it("is all zeros for an empty selection", () => {
    expect(selectionTotals(ITEMS, new Set())).toEqual({ count: 0, bytes: 0, citations: 0 });
  });

  it("ignores selected paths that are no longer in the queue", () => {
    const sel = new Set(["/v/sessions/gone.md", "/v/sessions/b.md"]);
    expect(selectionTotals(ITEMS, sel).citations).toBe(3);
  });
});

describe("harvestSelected", () => {
  const origin = { vaultPath: "/v", openingToken: "synthetic-native-opening" };
  const revision = "a".repeat(64);
  const empty = {
    ingested: false,
    held: 0,
    unsupported: 0,
    refused: 0,
    origin,
    sourceRevision: revision,
  };
  const copyResult = (rels: string[]) => ({
    copied: rels.length,
    inbox_rels: rels,
    skipped: [],
    inbox_sources: rels.map((rel) => ({
      source_rel: rel.replace("_inbox/", "sessions/"),
      inbox_rel: rel,
      source_revision: revision,
    })),
  });
  function setup(rels = ["_inbox/a.md", "_inbox/b.md"]) {
    return {
      origin,
      expectedVaultToken: "synthetic-ui-opening",
      paths: rels.map((rel) => `/v/${rel.replace("_inbox/", "sessions/")}`),
      copy: vi.fn().mockResolvedValue(copyResult(rels)),
      pass: vi.fn(
        async (
          _vault: string,
          options: { sourcePath: string },
        ): Promise<InboxPassOutcome> => ({
          ...empty,
          ingested: true,
          sourcePath: options.sourcePath,
          pendingChunks: 0,
          harvestCompleted: true,
        }),
      ),
      isCurrentVault: vi.fn(() => true),
      onProgress: vi.fn(),
    };
  }

  it("does not publish copy progress after the originating scope changed", async () => {
    const io = setup(["_inbox/a.md"]);
    let current = true;
    io.isCurrentVault.mockImplementation(() => current);
    io.copy.mockImplementationOnce(async () => {
      current = false;
      return copyResult(["_inbox/a.md"]);
    });

    const out = await harvestSelected("/v", ["/v/sessions/a.md"], io);

    expect(out).toMatchObject({ completed: 0, pending: 1, cancelled: true });
    expect(io.pass).not.toHaveBeenCalled();
    expect(io.onProgress).not.toHaveBeenCalled();
  });

  it("does not complete a copy whose actual harvest completion is false", async () => {
    const io = setup(["_inbox/a.md"]);
    const reply = {
      ...empty,
      ingested: true,
      sourcePath: "/v/_inbox/a.md",
      pendingChunks: 0,
      harvestCompleted: false,
    };
    io.pass.mockResolvedValueOnce(reply);

    const out = await harvestSelected("/v", ["/v/sessions/a.md"], io);

    expect(io.pass).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ completed: 0, pending: 1 });
    expect(io.onProgress).toHaveBeenCalledTimes(1);
    expect(io.onProgress).toHaveBeenLastCalledWith(0, 1);
  });

  it("processes exact selected copies and completes every evidence batch before advancing", async () => {
    const io = setup();
    io.pass
      .mockResolvedValueOnce({
        ...empty,
        sourcePath: "/v/_inbox/a.md",
        pendingChunks: 65,
      })
      .mockResolvedValueOnce({
        ...empty,
        sourcePath: "/v/_inbox/a.md",
        pendingChunks: 17,
      });
    const out = await harvestSelected(
      "/v",
      ["/v/sessions/a.md", "/v/sessions/b.md"],
      io,
    );
    expect(io.copy).toHaveBeenCalledWith(
      ["/v/sessions/a.md", "/v/sessions/b.md"],
      "/v",
      origin,
    );
    expect(io.pass.mock.calls.map((call) => call[1].sourcePath)).toEqual([
      "/v/_inbox/a.md",
      "/v/_inbox/a.md",
      "/v/_inbox/a.md",
      "/v/_inbox/b.md",
    ]);
    expect(out).toMatchObject({
      copied: 2,
      completed: 2,
      pending: 0,
      failed: [],
      cancelled: false,
    });
    expect(io.onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it("retains held and errored sources while completing the next selected source", async () => {
    const io = setup(["_inbox/held.md", "_inbox/error.md", "_inbox/good.md"]);
    io.pass
      .mockResolvedValueOnce({
        ...empty,
        held: 1,
        sourcePath: "/v/_inbox/held.md",
        pendingChunks: 0,
      })
      .mockResolvedValueOnce({
        ...empty,
        error: "read failed",
        sourcePath: "/v/_inbox/error.md",
        pendingChunks: 0,
      });
    expect(await harvestSelected("/v", io.paths, io)).toMatchObject({
      completed: 1,
      pending: 2,
      failed: [{ path: "/v/_inbox/error.md", reason: "read failed" }],
    });
  });

  it("does not count another source or an archive error as completion", async () => {
    const io = setup();
    io.pass
      .mockResolvedValueOnce({
        ...empty,
        ingested: true,
        sourcePath: "/v/_inbox/unrelated.md",
        pendingChunks: 0,
      })
      .mockResolvedValueOnce({
        ...empty,
        ingested: true,
        error: "archive failed",
        sourcePath: "/v/_inbox/b.md",
        pendingChunks: 0,
      });
    expect(await harvestSelected("/v", io.paths, io)).toMatchObject({
      completed: 0,
      pending: 2,
    });
  });

  it("stops a stalled partial source without hiding it or blocking later sources", async () => {
    const io = setup();
    io.pass
      .mockResolvedValueOnce({
        ...empty,
        sourcePath: "/v/_inbox/a.md",
        pendingChunks: 10,
      })
      .mockResolvedValueOnce({
        ...empty,
        sourcePath: "/v/_inbox/a.md",
        pendingChunks: 10,
      });
    const out = await harvestSelected("/v", io.paths, io);
    expect(out).toMatchObject({ completed: 1, pending: 1 });
    expect(io.pass).toHaveBeenCalledTimes(3);
  });

  it("bounds both one long source and the entire run", async () => {
    const io = setup(Array.from({ length: 20 }, (_, i) => `_inbox/${i}.md`));
    let remaining = 1000;
    io.pass.mockImplementation(async (_vault, options) => ({
      ...empty,
      sourcePath: options.sourcePath,
      pendingChunks: remaining--,
    }));
    expect(await harvestSelected("/v", io.paths, io)).toMatchObject({
      completed: 0,
      pending: 20,
    });
    expect(io.pass).toHaveBeenCalledTimes(64);
    expect(
      io.pass.mock.calls.filter(
        (call) => call[1].sourcePath === "/v/_inbox/0.md",
      ),
    ).toHaveLength(32);
  });

  it("stops on vault switch and never ingests an old copy into the new vault", async () => {
    const io = setup();
    let current = true;
    io.isCurrentVault.mockImplementation(() => current);
    io.pass.mockImplementationOnce(async (_vault, options) => {
      current = false;
      return {
        ...empty,
        ingested: true,
        sourcePath: options.sourcePath,
        pendingChunks: 0,
      };
    });
    expect(await harvestSelected("/v", io.paths, io)).toMatchObject({
      completed: 0,
      pending: 2,
      cancelled: true,
    });
    expect(io.pass).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a pass for an empty copy result or while another run is busy", async () => {
    const io = setup([]);
    expect(await harvestSelected("/v", io.paths, io)).toMatchObject({
      completed: 0,
      pending: 0,
    });
    expect(io.pass).not.toHaveBeenCalled();
    const busy = setup();
    busy.pass.mockResolvedValueOnce({
      ...empty,
      busy: true,
      pendingChunks: 0,
      sourcePath: "/v/_inbox/a.md",
    });
    expect(await harvestSelected("/v", busy.paths, busy)).toMatchObject({
      completed: 0,
      pending: 2,
    });
    expect(busy.pass).toHaveBeenCalledTimes(1);
  });

  it("retains the first native revision and opening in every bounded pass", async () => {
    const io = setup(["_inbox/a.md"]);
    io.pass.mockResolvedValueOnce({
      ...empty,
      sourcePath: "/v/_inbox/a.md",
      pendingChunks: 2,
    });
    await harvestSelected("/v", ["/v/sessions/a.md"], io);
    for (const call of io.pass.mock.calls)
      expect(call[1]).toEqual({
        sourcePath: "/v/_inbox/a.md",
        sourceRevision: revision,
        origin,
        expectedVaultToken: "synthetic-ui-opening",
        usage: "foreground",
      });
    expect(io.pass).toHaveBeenCalledTimes(2);
  });

  it("rejects an unbound copy before the first pass", async () => {
    const io = setup(["_inbox/a.md"]);
    io.copy.mockResolvedValueOnce({
      ...copyResult(["_inbox/a.md"]),
      inbox_sources: [],
    });
    const out = await harvestSelected("/v", ["/v/sessions/a.md"], io);
    expect(io.pass).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      completed: 0,
      pending: 1,
      failed: [{ path: "/v/_inbox/a.md", reason: expect.any(String) }],
    });
  });

  it("compiles one shared copy bound to two selected sources with identical revisions", async () => {
    const io = setup(["_inbox/a.md"]);
    io.copy.mockResolvedValueOnce({
      ...copyResult(["_inbox/a.md"]),
      inbox_sources: [
        {
          source_rel: "sessions/a.md",
          inbox_rel: "_inbox/a.md",
          source_revision: revision,
        },
        {
          source_rel: "sessions/b.md",
          inbox_rel: "_inbox/a.md",
          source_revision: revision,
        },
      ],
    });
    expect(
      await harvestSelected("/v", ["/v/sessions/a.md", "/v/sessions/b.md"], io),
    ).toMatchObject({
      copied: 1,
      completed: 1,
      pending: 0,
      failed: [],
    });
    expect(io.pass).toHaveBeenCalledTimes(1);
    expect(io.pass.mock.calls[0][1]).toMatchObject({
      sourceRevision: revision,
      origin,
    });
  });

  it.each(["revision", "unselected", "empty", "duplicate"])(
    "rejects a shared copy with %s binding metadata before compiling",
    async (invalid) => {
      const io = setup(["_inbox/a.md"]);
      io.copy.mockResolvedValueOnce({
        ...copyResult(["_inbox/a.md"]),
        inbox_sources: [
          {
            source_rel: "sessions/a.md",
            inbox_rel: "_inbox/a.md",
            source_revision: revision,
          },
          {
            source_rel:
              invalid === "empty"
                ? ""
                : invalid === "duplicate"
                  ? "sessions/a.md"
                  : invalid === "unselected"
                    ? "sessions/other.md"
                    : "sessions/b.md",
            inbox_rel: "_inbox/a.md",
            source_revision: invalid === "revision" ? "b".repeat(64) : revision,
          },
        ],
      });
      expect(
        await harvestSelected(
          "/v",
          ["/v/sessions/a.md", "/v/sessions/b.md"],
          io,
        ),
      ).toMatchObject({
        completed: 0,
        pending: 1,
        failed: [{ path: "/v/_inbox/a.md", reason: expect.any(String) }],
      });
      expect(io.pass).not.toHaveBeenCalled();
    },
  );

  it.each(["revision", "opening"])(
    "rejects a completed pass with a different %s",
    async (field) => {
      const io = setup(["_inbox/a.md"]);
      io.pass.mockResolvedValueOnce({
        ...empty,
        ingested: true,
        harvestCompleted: true,
        pendingChunks: 0,
        sourcePath: "/v/_inbox/a.md",
        sourceRevision: field === "revision" ? "b".repeat(64) : revision,
        origin:
          field === "opening"
            ? { ...origin, openingToken: "synthetic-reopened" }
            : origin,
      });
      expect(
        await harvestSelected("/v", ["/v/sessions/a.md"], io),
      ).toMatchObject({ completed: 0, pending: 1 });
      expect(io.onProgress).toHaveBeenLastCalledWith(0, 1);
    },
  );
});

describe("harvestLabel", () => {
  it("fills the count into the locale template", () => {
    expect(harvestLabel("{n}개 수확", 12)).toBe("12개 수확");
    expect(harvestLabel("Harvest {n}", 0)).toBe("Harvest 0");
  });
});

describe("excluded buckets", () => {
  const ex: HarvestExcluded = {
    already_harvested: 0,
    too_large: 3,
    duplicate: 754,
    too_small: 1231,
    boilerplate: 60,
  };

  it("renders in the fixed design order regardless of object key order or count", () => {
    expect(excludedRows(ex).map((r) => r.key)).toEqual([...EXCLUDED_ORDER]);
    expect(excludedRows(ex).map((r) => r.count)).toEqual([754, 60, 1231, 3, 0]);
  });

  it("counts only the junk buckets in the one-line total", () => {
    // 754 + 60 — the size buckets are held/below-floor, not thrown away.
    expect(junkExcluded(ex)).toBe(814);
  });
});

describe("formatKb", () => {
  it("shows bytes under 1 KB, one decimal under 100 KB, whole KB above", () => {
    expect(formatKb(5)).toBe("5 B");
    expect(formatKb(42.1 * 1024)).toBe("42.1 KB");
    expect(formatKb(204_800)).toBe("200 KB");
  });
});

describe("distinctCitations", () => {
  it("counts each source slug once across all pages", () => {
    const row = (slugs: string[]): ProvenanceRow => ({
      path: "p",
      name: "p",
      cited: slugs.length,
      total: slugs.length,
      sources: slugs.map((slug) => ({
        slug,
        kind: "",
        title: null,
        conversation_id: null,
        created: null,
        resolved: true,
      })),
    });
    expect(distinctCitations([row(["a", "b"]), row(["b", "c"]), row([])])).toBe(3);
  });
});

describe("clusterColorVar", () => {
  it("maps frontmatter types to the category tokens, untyped to concept", () => {
    expect(clusterColorVar("source-summary")).toBe("var(--c-source)");
    expect(clusterColorVar("analysis")).toBe("var(--c-analysis)");
    expect(clusterColorVar(undefined)).toBe("var(--c-concept)");
  });
});

describe("clusterLabel", () => {
  const cc = "claude-code-3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
  it("keeps a readable page's vault path, names an opaque session page", () => {
    expect(clusterLabel("wiki/vector-database.md")).toBe("wiki/vector-database");
    expect(clusterLabel(`wiki/source-${cc}.md`)).toBe("Claude Code · 3f2a9c1e");
    // Tidy's title, once the link graph carries it.
    expect(clusterLabel(`wiki/source-${cc}.md`, "서버 띄워봐. · Claude Code")).toBe(
      "서버 띄워봐. · Claude Code",
    );
  });
});

describe("harvestSurface", () => {
  const ex = {
    duplicate: 51,
    boilerplate: 0,
    too_small: 3,
    too_large: 0,
    already_harvested: 0,
  };

  it("earns the hero while nothing has ever been harvested", () => {
    expect(harvestSurface({ items: ITEMS, excluded: ex })).toBe("first-run");
  });

  it("collapses once a previous run took some and candidates remain", () => {
    const ran = { ...ex, already_harvested: 114 };
    expect(harvestSurface({ items: ITEMS, excluded: ran })).toBe("working");
  });

  it("is done when the queue is empty, harvested before or not", () => {
    const ran = { ...ex, already_harvested: 114 };
    expect(harvestSurface({ items: [], excluded: ex })).toBe("done");
    expect(harvestSurface({ items: [], excluded: ran })).toBe("done");
  });

  it("shows the hero while the first scan is still running", () => {
    expect(harvestSurface(null)).toBe("first-run");
  });
});

describe("queueProgress", () => {
  const base = {
    items: [{ path: "a" }, { path: "b" }] as never[],
    excluded: {
      duplicate: 51,
      boilerplate: 0,
      too_small: 3,
      too_large: 0,
      already_harvested: 0,
    },
    eligible: 137,
  };

  it("is null before the first harvest, so the never-run line shows", () => {
    expect(queueProgress(base)).toBeNull();
  });

  it("reports done, still-eligible and shown once a run has taken some", () => {
    expect(
      queueProgress({
        ...base,
        excluded: { ...base.excluded, already_harvested: 60 },
      }),
    ).toEqual({ done: 60, left: 137, shown: 2 });
  });
});
