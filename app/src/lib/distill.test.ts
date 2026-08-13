import { describe, expect, it, vi, beforeEach } from "vitest";

const draftMap = vi.fn();
vi.mock("./maps", () => ({ draftMap: (...a: unknown[]) => draftMap(...a) }));

// Controllable digest outcome — the cold-tier prune trigger keys off it.
const runSessionDigest = vi.fn();
vi.mock("./sessionDigest", () => ({
  runSessionDigest: (...a: unknown[]) => runSessionDigest(...a),
}));

import { backlogTrend, lastRunLabel, runDistillGuarded } from "./distill";
import { ipc } from "./ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useReindexStore } from "../stores/reindexStore";
import type { DistillConfig, RunReport } from "./distill";
import type { EmbeddingsStatus, FileNode, MycoSettings } from "./ipc";

describe("backlogTrend", () => {
  it("flat with fewer than two samples", () => {
    expect(backlogTrend([])).toBe("flat");
    expect(backlogTrend([5])).toBe("flat");
  });

  it("shrinking when the newest sample is below the oldest", () => {
    expect(backlogTrend([9, 7, 4])).toBe("shrinking");
  });

  it("growing when the newest sample is above the oldest", () => {
    expect(backlogTrend([2, 5, 9])).toBe("growing");
  });

  it("flat when the oldest and newest samples are equal", () => {
    expect(backlogTrend([5, 9, 5])).toBe("flat");
  });
});

describe("lastRunLabel", () => {
  const now = Date.UTC(2026, 7, 13, 12, 0, 0); // 2026-08-13T12:00:00Z

  it("null when never run", () => {
    expect(lastRunLabel(null, now)).toBeNull();
  });

  it("seconds ago", () => {
    expect(lastRunLabel(now / 1000 - 30, now)).toBe("30 seconds ago");
  });

  it("minutes ago", () => {
    expect(lastRunLabel(now / 1000 - 5 * 60, now)).toBe("5 minutes ago");
  });

  it("hours ago", () => {
    expect(lastRunLabel(now / 1000 - 3 * 3600, now)).toBe("3 hours ago");
  });

  it("days ago", () => {
    expect(lastRunLabel(now / 1000 - 2 * 86_400, now)).toBe("2 days ago");
  });
});

const REPORT: RunReport = {
  id: "r1",
  scan: {
    scored: 0,
    quarantined: 0,
    rejected: 0,
    summaries: 0,
    full: 0,
    skipped_immature: 0,
  },
  archived: 1,
  trashed: 0,
  proposals: 0,
  backlog_after: 0,
};

// The bug this guards against: schedule-due, count-trigger, and the manual
// button all decide to distill_run around the same moment, and a run can
// outlive the timer's 5-min poll — without a shared in-flight guard, two
// runs could interleave file moves.
describe("runDistillGuarded", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default: digest resolves with nothing to report (a bare vi.fn() would
    // return undefined and break the chain's .catch()).
    runSessionDigest.mockReset().mockResolvedValue(null);
  });

  it("a second concurrent call for the same vault gets null and makes no second ipc call", async () => {
    let release!: (r: RunReport) => void;
    const pending = new Promise<RunReport>((res) => {
      release = res;
    });
    const spy = vi.spyOn(ipc, "distillRun").mockReturnValue(pending);

    const first = runDistillGuarded("/v1");
    const second = await runDistillGuarded("/v1"); // first hasn't resolved yet
    expect(second).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);

    release(REPORT);
    expect(await first).toBe(REPORT);
  });

  it("allows a new run once the previous one resolves", async () => {
    const spy = vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    expect(await runDistillGuarded("/v2")).toBe(REPORT);
    expect(await runDistillGuarded("/v2")).toBe(REPORT);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("different vaults don't block each other", async () => {
    let release!: (r: RunReport) => void;
    const pending = new Promise<RunReport>((res) => {
      release = res;
    });
    vi.spyOn(ipc, "distillRun").mockImplementation((v: string) =>
      v === "/a" ? pending : Promise.resolve(REPORT),
    );
    const a = runDistillGuarded("/a");
    expect(await runDistillGuarded("/b")).toBe(REPORT);
    release(REPORT);
    expect(await a).toBe(REPORT);
  });
});

// Phase B, Task 4 — the Aggressive-intensity bridge: distill_run writes
// `draft-map` proposals straight to `status: approved` at that intensity, so
// runDistillGuarded must apply them the same way PageFeedback's approve
// button would, without waiting for a human click.
describe("runDistillGuarded — draft-map auto-apply (Aggressive bridge)", () => {
  const feedbackTree = (names: string[]): FileNode[] => [
    {
      kind: "directory",
      name: "work",
      path: "/vmap/work",
      children: [
        {
          kind: "directory",
          name: "feedback",
          path: "/vmap/work/feedback",
          children: names.map((n) => ({
            kind: "file" as const,
            name: n,
            path: `/vmap/work/feedback/${n}`,
          })),
        },
      ],
    },
  ];
  const TREE = feedbackTree(["p.md"]);

  const proposal = (status: string, cluster = "attention"): string =>
    "---\n" +
    "type: distill-proposal\n" +
    "action: draft-map\n" +
    `status: ${status}\n` +
    "created: 2026-08-13\n" +
    `payload: {"cluster":"${cluster}","members":["wiki/a.md","wiki/b.md"]}\n` +
    `---\n\n# Map candidate: ${cluster}\n\nbody\n`;

  // query provider drives the draft-map gate; ingest stays builtin-local so
  // the chain's full-tier step self-skips and the test only exercises maps.
  const settings = (queryProvider: string): MycoSettings =>
    ({
      query_provider: queryProvider,
      query_model: "",
      ingest_provider: "builtin-local",
      ingest_model: "",
    }) as unknown as MycoSettings;

  const CFG = { llm_ingest_budget: 3 } as unknown as DistillConfig;

  beforeEach(() => {
    vi.restoreAllMocks();
    draftMap.mockReset();
    runSessionDigest.mockReset().mockResolvedValue(null);
  });

  it("applies an approved draft-map proposal and marks it done", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("anthropic-api"));
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(TREE);
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/vmap/work/feedback/p.md",
      raw: proposal("approved"),
      content: "",
      frontmatter: {},
    });
    const writeFile = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    draftMap.mockResolvedValue("wiki/maps/attention.md");

    await runDistillGuarded("/vmap");

    expect(draftMap).toHaveBeenCalledWith("/vmap", "attention", ["wiki/a.md", "wiki/b.md"]);
    expect(writeFile).toHaveBeenCalledWith(
      "/vmap/work/feedback/p.md",
      expect.stringContaining("status: done"),
    );
  });

  it("leaves a pending draft-map proposal untouched", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("anthropic-api"));
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(TREE);
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/vmap/work/feedback/p.md",
      raw: proposal("pending"),
      content: "",
      frontmatter: {},
    });
    const writeFile = vi.spyOn(ipc, "writeFile");

    await runDistillGuarded("/vmap");

    expect(draftMap).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("makes zero draft calls on builtin-local (final-review Important 3)", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("builtin-local"));
    const listFiles = vi.spyOn(ipc, "listFiles");

    await runDistillGuarded("/vmap");

    expect(draftMap).not.toHaveBeenCalled();
    // Early return before the tree walk — not just before the LLM call.
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("triggers a prune reindex after a digest that archived files (final-review Important 6)", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    // builtin-local everywhere: full-tier and draft-map self-skip, isolating
    // the prune path.
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("builtin-local"));
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 42,
      model: "builtin-local:m",
    } as EmbeddingsStatus);
    runSessionDigest.mockResolvedValue({ daysDigested: 1, filesArchived: 3, skipped: null });

    const prevVault = useVaultStore.getState().currentVault;
    const prevReindex = useReindexStore.getState().reindex;
    const reindex = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ currentVault: { path: "/vprune" } as never });
    useReindexStore.setState({ reindex });
    try {
      await runDistillGuarded("/vprune");
      expect(reindex).toHaveBeenCalledTimes(1);
    } finally {
      useVaultStore.setState({ currentVault: prevVault });
      useReindexStore.setState({ reindex: prevReindex });
    }
  });

  it("never triggers a FIRST index build as a prune side effect", async () => {
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("builtin-local"));
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 0, // no index yet — the first build stays a deliberate action
      model: "",
    } as EmbeddingsStatus);
    runSessionDigest.mockResolvedValue({ daysDigested: 1, filesArchived: 3, skipped: null });

    const prevVault = useVaultStore.getState().currentVault;
    const prevReindex = useReindexStore.getState().reindex;
    const reindex = vi.fn();
    useVaultStore.setState({ currentVault: { path: "/vprune" } as never });
    useReindexStore.setState({ reindex });
    try {
      await runDistillGuarded("/vprune");
      expect(reindex).not.toHaveBeenCalled();
    } finally {
      useVaultStore.setState({ currentVault: prevVault });
      useReindexStore.setState({ reindex: prevReindex });
    }
  });

  it("caps one run's draft applies at llm_ingest_budget", async () => {
    const names = ["p1.md", "p2.md", "p3.md", "p4.md", "p5.md"];
    vi.spyOn(ipc, "distillRun").mockResolvedValue(REPORT);
    vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("anthropic-api"));
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue(CFG); // budget 3
    vi.spyOn(ipc, "listFiles").mockResolvedValue(feedbackTree(names));
    vi.spyOn(ipc, "readFile").mockImplementation((path: string) =>
      Promise.resolve({
        path,
        raw: proposal("approved", path.split("/").pop()!.replace(".md", "")),
        content: "",
        frontmatter: {},
      }),
    );
    const writeFile = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    draftMap.mockResolvedValue("wiki/maps/x.md");

    await runDistillGuarded("/vmap");

    expect(draftMap).toHaveBeenCalledTimes(3);
    expect(writeFile).toHaveBeenCalledTimes(3);
  });
});
