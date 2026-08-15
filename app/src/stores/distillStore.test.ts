import { beforeEach, describe, expect, it, vi } from "vitest";

// `apply()`'s draft-map branch calls the REAL `draftMap` (not mocked) so
// this exercises its actual idempotency check — only `complete` (the LLM
// call inside it) is stubbed, mirroring `maps.test.ts`'s own mock.
const complete = vi.fn();
vi.mock("../lib/chat", () => ({ complete: (...a: unknown[]) => complete(...a) }));

import { useDistillStore, parseProposal } from "./distillStore";
import { useVaultStore } from "./vaultStore";
import { ipc } from "../lib/ipc";
import type { FileNode } from "../lib/ipc";
import type { DistillStatus } from "../lib/distill";

const STATUS: DistillStatus = {
  backlog: 5,
  pending_proposals: 1,
  last_run: 1_755_000_000,
  last_backlogs: [10, 8, 5],
  gate_active: true,
  last_run_id: "20250812T120000",
  wiki_pages: 60,
  quarantined: 4,
};

const PROPOSAL_RAW = [
  "---",
  "type: distill-proposal",
  "action: admit-cluster",
  "status: pending",
  "created: 2026-08-10",
  'payload: {"files":["_inbox/quarantine/a.md","_inbox/quarantine/b.md"]}',
  "---",
  "",
  "# Emerging cluster: rope",
  "",
  "Body text.",
  "",
].join("\n");

function tree(): FileNode[] {
  return [
    {
      kind: "directory",
      name: "work",
      path: "/v/work",
      children: [
        {
          kind: "directory",
          name: "feedback",
          path: "/v/work/feedback",
          children: [
            { kind: "file", name: "2026-08-10-rope.md", path: "/v/work/feedback/2026-08-10-rope.md" },
          ],
        },
      ],
    },
  ];
}

describe("parseProposal", () => {
  it("parses frontmatter, title and payload files", () => {
    const p = parseProposal("work/feedback/2026-08-10-rope.md", PROPOSAL_RAW);
    expect(p).not.toBeNull();
    expect(p?.action).toBe("admit-cluster");
    expect(p?.status).toBe("pending");
    expect(p?.created).toBe("2026-08-10");
    expect(p?.title).toBe("Emerging cluster: rope");
    expect(p?.files).toEqual(["_inbox/quarantine/a.md", "_inbox/quarantine/b.md"]);
  });

  it("returns null for non-proposal markdown", () => {
    expect(parseProposal("wiki/x.md", "# hi\n\nregular note\n")).toBeNull();
  });
});

describe("useDistillStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    complete.mockReset();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useDistillStore.setState({ status: null, proposals: [], loading: false });
  });

  it("refresh populates status and pending proposals from mocked ipc", async () => {
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(tree());
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/v/work/feedback/2026-08-10-rope.md",
      raw: PROPOSAL_RAW,
      content: PROPOSAL_RAW,
      frontmatter: null,
    });

    await useDistillStore.getState().refresh();

    expect(useDistillStore.getState().status).toEqual(STATUS);
    expect(useDistillStore.getState().proposals).toHaveLength(1);
    expect(useDistillStore.getState().proposals[0].path).toBe(
      "work/feedback/2026-08-10-rope.md",
    );
  });

  it("apply rewrites status to approved, calls the ipc command, then removes it from the list", async () => {
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(tree());
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/v/work/feedback/2026-08-10-rope.md",
      raw: PROPOSAL_RAW,
      content: PROPOSAL_RAW,
      frontmatter: null,
    });
    await useDistillStore.getState().refresh();
    expect(useDistillStore.getState().proposals).toHaveLength(1);

    const writeSpy = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    const applySpy = vi
      .spyOn(ipc, "applyDistillProposal")
      .mockResolvedValue("moved 2, skipped 0 already-processed");
    // Post-apply refresh should see the proposal gone (status flipped server-side).
    vi.spyOn(ipc, "distillStatus").mockResolvedValue({ ...STATUS, pending_proposals: 0 });
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);

    const summary = await useDistillStore.getState().apply("work/feedback/2026-08-10-rope.md");

    expect(writeSpy).toHaveBeenCalledWith(
      "/v/work/feedback/2026-08-10-rope.md",
      expect.stringContaining("status: approved"),
    );
    expect(applySpy).toHaveBeenCalledWith("/v", "work/feedback/2026-08-10-rope.md");
    expect(summary).toBe("moved 2, skipped 0 already-processed");
    expect(useDistillStore.getState().proposals).toHaveLength(0);
  });

  it("apply surfaces an error and keeps the proposal listed as approved when applyDistillProposal rejects, then a retry completes it without re-rewriting status", async () => {
    // A tiny in-memory fake for the proposal file: readFile/writeFile share
    // this `raw` so a rewrite is actually visible on the next read, the same
    // way the real vault-file round-trip behaves.
    let raw = PROPOSAL_RAW;
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(tree());
    vi.spyOn(ipc, "readFile").mockImplementation(async () => ({
      path: "/v/work/feedback/2026-08-10-rope.md",
      raw,
      content: raw,
      frontmatter: null,
    }));
    const writeSpy = vi.spyOn(ipc, "writeFile").mockImplementation(async (_p, content) => {
      raw = content;
      return null;
    });
    // First call: rejects (backend failure AFTER the pending->approved rewrite
    // already landed on disk). Second call (the retry): succeeds and, like the
    // real apply_proposal, flips status to done.
    const applySpy = vi
      .spyOn(ipc, "applyDistillProposal")
      .mockRejectedValueOnce(new Error("backend boom"))
      .mockImplementationOnce(async () => {
        raw = raw.replace(/^status:\s*\S+\s*$/m, "status: done");
        return "moved 2, skipped 0 already-processed";
      });

    const first = await useDistillStore.getState().apply("work/feedback/2026-08-10-rope.md");
    expect(first).toBeNull();
    expect(useDistillStore.getState().error).toContain("backend boom");
    expect(useDistillStore.getState().proposals).toHaveLength(1);
    expect(useDistillStore.getState().proposals[0].status).toBe("approved");
    expect(writeSpy).toHaveBeenCalledTimes(1); // the one pending->approved rewrite

    const second = await useDistillStore.getState().apply("work/feedback/2026-08-10-rope.md");
    expect(second).toBe("moved 2, skipped 0 already-processed");
    expect(useDistillStore.getState().error).toBeNull();
    expect(applySpy).toHaveBeenCalledTimes(2);
    // The retry must NOT re-rewrite — it was already approved.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(useDistillStore.getState().proposals).toHaveLength(0);
  });

  it("dismiss rewrites status to dismissed and refreshes", async () => {
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(tree());
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/v/work/feedback/2026-08-10-rope.md",
      raw: PROPOSAL_RAW,
      content: PROPOSAL_RAW,
      frontmatter: null,
    });
    await useDistillStore.getState().refresh();

    const writeSpy = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);

    await useDistillStore.getState().dismiss("work/feedback/2026-08-10-rope.md");

    expect(writeSpy).toHaveBeenCalledWith(
      "/v/work/feedback/2026-08-10-rope.md",
      expect.stringContaining("status: dismissed"),
    );
    expect(useDistillStore.getState().proposals).toHaveLength(0);
  });

  it("apply on a draft-map proposal for an already-mapped cluster skips the LLM call and still flips status to done", async () => {
    // Retry scenario Important-1 fixes: the proposal is already `approved`
    // (a prior attempt drafted the map, then crashed before this rewrite),
    // AND a `wiki/maps/` page already carries this exact cluster label —
    // draftMap's own idempotency check must return that page's path without
    // calling complete(), and this call must still complete the proposal.
    const draftMapProposalRaw = [
      "---",
      "type: distill-proposal",
      "action: draft-map",
      "status: approved",
      "created: 2026-08-10",
      'payload: {"cluster":"attention","members":["wiki/a.md","wiki/b.md"]}',
      "---",
      "",
      "# Map candidate: attention",
      "",
      "Body text.",
      "",
    ].join("\n");
    const proposalPath = "/v/work/feedback/2026-08-10-map.md";

    vi.spyOn(ipc, "listFiles").mockResolvedValue([
      {
        kind: "directory",
        name: "wiki",
        path: "/v/wiki",
        children: [
          {
            kind: "directory",
            name: "maps",
            path: "/v/wiki/maps",
            children: [{ kind: "file", name: "attention.md", path: "/v/wiki/maps/attention.md" }],
          },
        ],
      },
    ]);
    vi.spyOn(ipc, "readFile").mockImplementation(async (path: string) =>
      path === proposalPath
        ? { path, raw: draftMapProposalRaw, content: "", frontmatter: null }
        : { path, raw: "", content: "", frontmatter: { cluster: "attention" } },
    );
    const writeSpy = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);

    const rel = await useDistillStore.getState().apply("work/feedback/2026-08-10-map.md");

    expect(complete).not.toHaveBeenCalled();
    expect(rel).toBe("wiki/maps/attention.md");
    expect(writeSpy).toHaveBeenCalledWith(proposalPath, expect.stringContaining("status: done"));
  });

  it("does nothing without an open vault", async () => {
    useVaultStore.setState({ currentVault: null });
    const spy = vi.spyOn(ipc, "distillStatus");
    await useDistillStore.getState().refresh();
    expect(spy).not.toHaveBeenCalled();
    expect(useDistillStore.getState().status).toBeNull();
  });
});
