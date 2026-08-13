import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("does nothing without an open vault", async () => {
    useVaultStore.setState({ currentVault: null });
    const spy = vi.spyOn(ipc, "distillStatus");
    await useDistillStore.getState().refresh();
    expect(spy).not.toHaveBeenCalled();
    expect(useDistillStore.getState().status).toBeNull();
  });
});
