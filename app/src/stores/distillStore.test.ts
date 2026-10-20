import { beforeEach, describe, expect, it, vi } from "vitest";

// `apply()`'s draft-map branch calls the REAL `draftMap` (not mocked) so
// this exercises its actual idempotency check — only `complete` (the LLM
// call inside it) is stubbed, mirroring `maps.test.ts`'s own mock.
const complete = vi.fn();
// What getActiveModel("generate") reports — a provider that writes by
// default, so the draft-map tests below reach draftMap; canGenerate stays real.
let generateProvider = "anthropic-api";
vi.mock("../lib/chat", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  complete: (...a: unknown[]) => complete(...a),
  getActiveModel: async () => ({ provider: generateProvider, model: generateProvider === "builtin-local" ? "extractive-ingest" : "synthetic-writer", effort: "(default)" }),
}));

import {
  confirmQuarantineBatch,
  useDistillStore,
  parseProposal,
  pendingMapProposals,
  proposalNotice,
  proposalOutcome,
  settingsNeedWriter,
  withQuarantineLock,
} from "./distillStore";
import type { ProposalMeta } from "./distillStore";
import { useVaultStore } from "./vaultStore";
import { useSettingsStore } from "./settingsStore";
import { useUIStore } from "./uiStore";
import { useDialogStore } from "./dialogStore";
import { ipc } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";
import type { FileNode, MycoSettings } from "../lib/ipc";
import type { DistillStatus } from "../lib/distill";
import { roleFixture, selectedRolesFixture } from "../lib/modelRoles.testSupport";
import { BUILTIN_CHAT_MODEL } from "../lib/providers";

function mockOrganizationRole(): void {
  vi.spyOn(ipc, "captureModelRole").mockImplementation(async (origin, role, usage) => {
    expect(role).toBe("organization");
    return roleFixture(role, generateProvider, generateProvider === "builtin-local" ? "extractive-ingest" : "synthetic-writer", origin, usage);
  });
}

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

// An `archive-batch` proposal a run before B1 (2026-10-03) left behind.
const ARCHIVE_RAW = PROPOSAL_RAW.replace("action: admit-cluster", "action: archive-batch").replace(
  '"files":["_inbox/quarantine/a.md","_inbox/quarantine/b.md"]',
  '"files":["raw/a.md"]',
);

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

describe("pendingMapProposals", () => {
  const proposal = (
    over: Partial<ProposalMeta> & Pick<ProposalMeta, "path">,
  ): ProposalMeta => ({
    action: "draft-map",
    status: "pending",
    created: "2026-08-12",
    title: "Map candidate",
    raw: "",
    files: [],
    ...over,
  });

  it("keeps only pending draft-map proposals, in order", () => {
    const rows = pendingMapProposals([
      proposal({ path: "a.md", cluster: "attention" }),
      // Other actions belong to the Feedback page, not the activity rows.
      proposal({ path: "b.md", action: "admit-cluster" }),
      // Already decided — it waits on the draft step, not on the user.
      proposal({ path: "c.md", status: "approved" }),
      proposal({ path: "d.md", cluster: "rope" }),
    ]);
    expect(rows.map((p) => p.path)).toEqual(["a.md", "d.md"]);
  });

  it("is empty for an empty list", () => {
    expect(pendingMapProposals([])).toEqual([]);
  });
});

describe("proposalNotice", () => {
  const card = (over: Partial<ProposalMeta>): ProposalMeta => ({
    path: "work/feedback/p.md",
    action: "draft-map",
    status: "pending",
    created: "2026-10-02",
    title: "Map candidate: attention-mechanism",
    raw: "",
    files: [],
    ...over,
  });

  it("says an approved map with no writing model needs one, not that it failed", () => {
    expect(proposalNotice(card({ status: "approved" }), true)).toBe("needs-writer");
    expect(proposalNotice(card({ status: "pending" }), true)).toBe("needs-writer");
  });

  it("keeps the failed line once a writing model is set, and for other kinds", () => {
    expect(proposalNotice(card({ status: "approved" }), false)).toBe("failed");
    expect(proposalNotice(card({ status: "pending" }), false)).toBeNull();
    // Only a map is written by a model; the other kinds move files.
    expect(proposalNotice(card({ action: "admit-cluster", status: "approved" }), true)).toBe(
      "failed",
    );
  });

  it("says an old raw/ archive proposal is no longer needed, pending or approved", () => {
    expect(proposalNotice(card({ action: "archive-batch" }), true)).toBe("retired");
    expect(proposalNotice(card({ action: "archive-batch", status: "approved" }), false)).toBe(
      "retired",
    );
  });
});

// The sentence beside Approve (S20): what the click does, from the kind.
describe("proposalOutcome", () => {
  const card = (over: Partial<ProposalMeta>): ProposalMeta => ({
    path: "work/feedback/p.md",
    action: "admit-cluster",
    status: "pending",
    created: "2026-10-02",
    title: "Emerging cluster",
    raw: "",
    files: ["_inbox/quarantine/a.md", "_inbox/quarantine/b.md"],
    ...over,
  });

  it("names what each kind moves, and how many", () => {
    expect(proposalOutcome(card({}), STRINGS.ko)).toBe(
      "격리된 자료 2개를 볼트로 되돌립니다.",
    );
    expect(proposalOutcome(card({ action: "delete-batch", files: ["x"] }), STRINGS.en)).toBe(
      "Moves 1 quarantined item(s) to the trash.",
    );
  });

  it("says a map is drafted, not that files move", () => {
    expect(proposalOutcome(card({ action: "draft-map", files: [] }), STRINGS.en)).toBe(
      STRINGS.en.pf_confirm_msg_draft_map,
    );
  });
});

// The popover and tray note: the generate role, which draftMap calls, decides —
// not the query role, which used to say "needs a model" while a writing
// ingest provider sat connected.
describe("settingsNeedWriter", () => {
  const s = (providerId: string, modelId: string): MycoSettings =>
    ({ model_roles: selectedRolesFixture({ organization: { providerId, modelId } }) }) as MycoSettings;

  it("uses only the selected Organization provider and model capability", () => {
    expect(settingsNeedWriter(s("builtin-local", "extractive-ingest"))).toBe(true);
    expect(settingsNeedWriter(s("builtin-local", BUILTIN_CHAT_MODEL))).toBe(false);
    expect(settingsNeedWriter(s("anthropic-api", "synthetic-writer"))).toBe(false);
    expect(settingsNeedWriter({ ...s("builtin-local", "extractive-ingest"), query_provider: "anthropic-api", ingest_provider: "anthropic-api" })).toBe(true);
  });

  it("claims nothing before settings load", () => {
    expect(settingsNeedWriter(null)).toBe(false);
  });
});

describe("useDistillStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Native origin capture is IPC; the store/map logic remains real in Node.
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: "/v", openingToken: "synthetic-native-opening" });
    mockOrganizationRole();
    complete.mockReset();
    generateProvider = "anthropic-api";
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useDistillStore.setState({
      status: null,
      proposals: [],
      loading: false,
      error: null,
      needsWriter: false,
    });
  });

  it("apply on a draft-map with no writing model writes nothing, calls no model, sets no error, and marks needs-writer", async () => {
    generateProvider = "builtin-local";
    const raw = [
      "---",
      "type: distill-proposal",
      "action: draft-map",
      "status: pending",
      "created: 2026-10-02",
      'payload: {"cluster":"attention-mechanism","members":["wiki/a.md","wiki/b.md"]}',
      "---",
      "",
      "# Map candidate: attention-mechanism",
      "",
    ].join("\n");
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(tree());
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/v/work/feedback/2026-08-10-rope.md",
      raw,
      content: raw,
      frontmatter: null,
    });
    const writeSpy = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);

    const result = await useDistillStore.getState().apply("work/feedback/2026-08-10-rope.md");

    expect(result).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(useDistillStore.getState().error).toBeNull();
    expect(useDistillStore.getState().needsWriter).toBe(true);
    expect(useDistillStore.getState().proposals[0].status).toBe("pending");
  });

  it("apply reports CHAT_MODEL_MISSING in the UI language, not the backend's English", async () => {
    const raw = [
      "---",
      "type: distill-proposal",
      "action: draft-map",
      "status: approved",
      "created: 2026-10-02",
      'payload: {"cluster":"attention-mechanism","members":["wiki/a.md"]}',
      "---",
      "",
      "# Map candidate: attention-mechanism",
      "",
    ].join("\n");
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readFile").mockResolvedValue({ path: "", raw, content: raw, frontmatter: null });
    complete.mockRejectedValue(
      new Error(
        "no local chat model is bundled: Ask answers extractively from your notes; " +
          "classification and generation need a connected provider (Settings → Model)",
      ),
    );
    const lang = useUIStore.getState().lang;
    useUIStore.setState({ lang: "ko" });

    await useDistillStore.getState().apply("work/feedback/map.md");

    expect(useDistillStore.getState().error).toBe(STRINGS.ko.pf_map_needs_writer);
    useUIStore.setState({ lang });
  });

  it("refresh clears a stale error", async () => {
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    useDistillStore.setState({ error: "Error: an earlier apply" });
    await useDistillStore.getState().refresh();
    expect(useDistillStore.getState().error).toBeNull();
  });

  it("a tab switch clears the error, so 격리 does not carry 제안's red line", () => {
    useUIStore.getState().setFeedbackTab("proposals");
    useDistillStore.setState({ error: "Error: an earlier apply" });
    useUIStore.getState().setFeedbackTab("quarantine");
    expect(useDistillStore.getState().error).toBeNull();
    useDistillStore.setState({ error: "Error: a quarantine action" });
    useUIStore.getState().setFeedbackTab("proposals");
    expect(useDistillStore.getState().error).toBeNull();
  });

  it("a quarantine action's error survives the refresh that follows it", async () => {
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "restoreQuarantine").mockRejectedValue(new Error("restore boom"));
    await useDistillStore.getState().restoreQuarantine(["_inbox/quarantine/a.md"]);
    expect(useDistillStore.getState().error).toContain("restore boom");
  });

  it("refresh says whether the generate role can write a map", async () => {
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    generateProvider = "builtin-local";
    await useDistillStore.getState().refresh();
    expect(useDistillStore.getState().needsWriter).toBe(true);
    generateProvider = "anthropic-api";
    await useDistillStore.getState().refresh();
    expect(useDistillStore.getState().needsWriter).toBe(false);
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

  it("refresh retires an old raw/ archive proposal: marks it done, lists it no more, recounts", async () => {
    let raw = ARCHIVE_RAW;
    const statusSpy = vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
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
    const applySpy = vi.spyOn(ipc, "applyDistillProposal");

    await useDistillStore.getState().refresh();

    expect(writeSpy).toHaveBeenCalledWith(
      "/v/work/feedback/2026-08-10-rope.md",
      expect.stringContaining("status: done"),
    );
    expect(applySpy).not.toHaveBeenCalled();
    expect(useDistillStore.getState().proposals).toHaveLength(0);
    // The badge count is read again after the retire, not before it.
    expect(statusSpy).toHaveBeenCalledTimes(2);
    expect(useDistillStore.getState().error).toBeNull();
  });

  it("refresh keeps an old raw/ archive proposal listed when marking it done fails", async () => {
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(tree());
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/v/work/feedback/2026-08-10-rope.md",
      raw: ARCHIVE_RAW,
      content: ARCHIVE_RAW,
      frontmatter: null,
    });
    vi.spyOn(ipc, "writeFile").mockRejectedValue(new Error("disk full"));

    await useDistillStore.getState().refresh();

    const listed = useDistillStore.getState().proposals;
    expect(listed).toHaveLength(1);
    expect(proposalNotice(listed[0], false)).toBe("retired");
  });

  it("apply on an old raw/ archive proposal marks it done without the backend, error-free", async () => {
    let raw = ARCHIVE_RAW;
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readFile").mockImplementation(async () => ({
      path: "/v/work/feedback/2026-08-10-rope.md",
      raw,
      content: raw,
      frontmatter: null,
    }));
    vi.spyOn(ipc, "writeFile").mockImplementation(async (_p, content) => {
      raw = content;
      return null;
    });
    const applySpy = vi.spyOn(ipc, "applyDistillProposal");

    const summary = await useDistillStore.getState().apply("work/feedback/2026-08-10-rope.md");

    expect(summary).toBeNull();
    expect(applySpy).not.toHaveBeenCalled();
    expect(raw).toContain("status: done");
    expect(useDistillStore.getState().error).toBeNull();
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

    expect(await useDistillStore.getState().dismiss("work/feedback/2026-08-10-rope.md")).toBe(true);

    expect(writeSpy).toHaveBeenCalledWith(
      "/v/work/feedback/2026-08-10-rope.md",
      expect.stringContaining("status: dismissed"),
    );
    expect(useDistillStore.getState().proposals).toHaveLength(0);
  });

  it.each(["read", "write"])("dismiss reports a %s failure after refresh and leaves the proposal pending", async (operation) => {
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(tree());
    const read = vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/v/work/feedback/2026-08-10-rope.md",
      raw: PROPOSAL_RAW,
      content: PROPOSAL_RAW,
      frontmatter: null,
    });
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    if (operation === "read") read.mockRejectedValueOnce(new Error("synthetic read failure"));
    else write.mockRejectedValueOnce(new Error("synthetic write failure"));

    expect(await useDistillStore.getState().dismiss("work/feedback/2026-08-10-rope.md")).toBe(false);
    expect(useDistillStore.getState().error).toBe(`Error: synthetic ${operation} failure`);
    expect(useDistillStore.getState().proposals).toHaveLength(1);
    expect(useDistillStore.getState().proposals[0].status).toBe("pending");
    expect(useDistillStore.getState().loading).toBe(false);
    if (operation === "read") expect(write).not.toHaveBeenCalled();
  });

  it("dismiss returns false without a vault and performs no file IO", async () => {
    useVaultStore.setState({ currentVault: null });
    const read = vi.spyOn(ipc, "readFile");
    const write = vi.spyOn(ipc, "writeFile");
    expect(await useDistillStore.getState().dismiss("work/feedback/2026-08-10-rope.md")).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps an already-mapped legacy proposal approved for manual recovery", async () => {
    // Existing bytes and a matching cluster do not prove native ownership.
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
    expect(rel).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(useDistillStore.getState().error).toContain("manual recovery");
  });

  // The activity popover / tray panel approve buttons call this very action
  // (there is no second writer), one row at a time.
  it("approves two legacy map rows once and keeps both pending manual recovery", async () => {
    const rawFor = (cluster: string, members: string[]): string =>
      [
        "---",
        "type: distill-proposal",
        "action: draft-map",
        "status: pending",
        "created: 2026-08-12",
        `payload: {"cluster":"${cluster}","members":${JSON.stringify(members)}}`,
        "---",
        "",
        `# Map candidate: ${cluster}`,
        "",
      ].join("\n");
    const files = new Map<string, string>([
      ["/v/work/feedback/map-attention.md", rawFor("attention", ["wiki/a.md"])],
      ["/v/work/feedback/map-rope.md", rawFor("rope", ["wiki/b.md"])],
    ]);
    // Both existing maps lack native capabilities; approval does not imply done.
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
            children: [
              { kind: "file", name: "attention.md", path: "/v/wiki/maps/attention.md" },
              { kind: "file", name: "rope.md", path: "/v/wiki/maps/rope.md" },
            ],
          },
        ],
      },
    ]);
    vi.spyOn(ipc, "readFile").mockImplementation(async (path: string) => {
      const raw = files.get(path);
      if (raw !== undefined) return { path, raw, content: raw, frontmatter: null };
      const cluster = path.includes("rope") ? "rope" : "attention";
      return { path, raw: "", content: "", frontmatter: { cluster } };
    });
    const writeSpy = vi.spyOn(ipc, "writeFile").mockImplementation(async (p, content) => {
      files.set(p, content);
      return null;
    });

    await useDistillStore.getState().apply("work/feedback/map-attention.md");
    await useDistillStore.getState().apply("work/feedback/map-rope.md");

    expect(complete).not.toHaveBeenCalled();
    for (const path of ["/v/work/feedback/map-attention.md", "/v/work/feedback/map-rope.md"]) {
      const approvals = writeSpy.mock.calls.filter(
        ([p, c]) => p === path && c.includes("status: approved"),
      );
      expect(approvals).toHaveLength(1);
      expect(files.get(path)).toContain("status: approved");
      expect(files.get(path)).not.toContain("status: done");
    }
  });

  it("does nothing without an open vault", async () => {
    useVaultStore.setState({ currentVault: null });
    const spy = vi.spyOn(ipc, "distillStatus");
    await useDistillStore.getState().refresh();
    expect(spy).not.toHaveBeenCalled();
    expect(useDistillStore.getState().status).toBeNull();
  });
});

// A draft-map apply dedups against existing maps BEFORE its LLM call, so two
// overlapping applies of the same proposal used to write two pages for one
// cluster (double-click, or the popover racing the tray panel).
describe("apply is one-at-a-time per proposal", () => {
  it("drops a second apply of the same proposal while the first is in flight", async () => {
    const store = useDistillStore;
    store.setState({ applying: new Set(["work/feedback/p.md"]) });
    expect(await store.getState().apply("work/feedback/p.md")).toBeNull();
    store.setState({ applying: new Set() });
  });
});

// 결정 10: the 격리 tab restores or trashes a whole group behind an in-page
// confirmation (the dialogStore modal; window.confirm is swallowed by Tauri).
describe("proposal actions retain their originating vault session", () => {
  const rel = "work/feedback/shared.md";
  const file = (raw = PROPOSAL_RAW) => ({ path: `/v/${rel}`, raw, content: raw, frontmatter: null });
  function reopen() {
    useVaultStore.setState({ currentVault: { path: "/other", name: "other" }, vaultToken: "other-session" });
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, vaultToken: "reopened-session" });
  }
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: "/v", openingToken: "synthetic-native-origin" });
    mockOrganizationRole();
    complete.mockReset();
    generateProvider = "anthropic-api";
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, vaultToken: "origin-session", isOpeningVault: false });
    useDistillStore.setState({ status: null, proposals: [], quarantine: [], loading: false, error: null, needsWriter: false, applying: new Set() });
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "listQuarantine").mockResolvedValue([]);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    vi.spyOn(ipc, "applyDistillProposal").mockResolvedValue("synthetic applied");
  });

  it.each(["apply", "dismiss"] as const)("stops %s after a late read across A → B → A", async (action) => {
    let finish!: (value: ReturnType<typeof file>) => void;
    vi.spyOn(ipc, "readFile").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useDistillStore.getState()[action](rel);
    reopen();
    useDistillStore.setState({ error: "new session error", applying: new Set([rel]) });
    finish(file());
    expect(await pending).toBe(action === "apply" ? null : false);
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(ipc.applyDistillProposal).not.toHaveBeenCalled();
    expect(ipc.distillStatus).not.toHaveBeenCalled();
    expect(useDistillStore.getState().error).toBe("new session error");
    expect(useDistillStore.getState().applying.has(rel)).toBe(true);
  });

  it("does not dispatch the lifecycle step after an earlier approval write completes late", async () => {
    vi.spyOn(ipc, "readFile").mockResolvedValue(file());
    let finish!: () => void;
    vi.mocked(ipc.writeFile).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(null); }));
    const pending = useDistillStore.getState().apply(rel);
    await vi.waitFor(() => expect(ipc.writeFile).toHaveBeenCalledOnce());
    reopen();
    finish();
    expect(await pending).toBeNull();
    expect(ipc.applyDistillProposal).not.toHaveBeenCalled();
    expect(ipc.distillStatus).not.toHaveBeenCalled();
  });

  it("keeps an in-flight absolute proposal locked across A → B → A", async () => {
    let finish!: (value: ReturnType<typeof file>) => void;
    const read = vi.spyOn(ipc, "readFile").mockResolvedValue(file())
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useDistillStore.getState().apply(rel);
    reopen();
    try {
      expect(await useDistillStore.getState().apply(rel)).toBeNull();
      expect(read).toHaveBeenCalledOnce();
    } finally {
      finish(file());
      await pending;
    }
    expect(await useDistillStore.getState().apply(rel)).toBe("synthetic applied");
  });

  it("allows a different vault's proposal with the same relative name", async () => {
    let finish!: (value: ReturnType<typeof file>) => void;
    const read = vi.spyOn(ipc, "readFile").mockImplementation(async (path) => ({ ...file(), path }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useDistillStore.getState().apply(rel);
    useVaultStore.setState({ currentVault: { path: "/other", name: "other" }, vaultToken: "other-session" });
    try {
      expect(await useDistillStore.getState().apply(rel)).toBe("synthetic applied");
      expect(read.mock.calls.map(([path]) => path)).toEqual([`/v/${rel}`, `/other/${rel}`]);
      expect(ipc.writeFile).toHaveBeenCalledWith(`/other/${rel}`, expect.stringContaining("status: approved"));
    } finally {
      finish(file());
      await pending;
    }
  });

  it.each(["success", "failure"])("ignores a late lifecycle %s without unlocking the new session", async (outcome) => {
    vi.spyOn(ipc, "readFile").mockResolvedValue(file(PROPOSAL_RAW.replace("status: pending", "status: approved")));
    let finish!: () => void;
    vi.mocked(ipc.applyDistillProposal).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => outcome === "success" ? resolve("old applied") : reject(new Error("old session failure"));
    }));
    const pending = useDistillStore.getState().apply(rel);
    await vi.waitFor(() => expect(ipc.applyDistillProposal).toHaveBeenCalledOnce());
    reopen();
    useDistillStore.setState({ error: "new session error", applying: new Set([rel]) });
    finish();
    expect(await pending).toBeNull();
    expect(ipc.distillStatus).not.toHaveBeenCalled();
    expect(useDistillStore.getState().error).toBe("new session error");
    expect(useDistillStore.getState().applying.has(rel)).toBe(true);
  });

  it("does not retire or publish an old refresh after reopening the same path", async () => {
    vi.mocked(ipc.listFiles).mockResolvedValue(tree());
    let finish!: (value: ReturnType<typeof file>) => void;
    const read = vi.spyOn(ipc, "readFile").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useDistillStore.getState().refresh();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    reopen();
    const fresh = { ...STATUS, pending_proposals: 9 };
    useDistillStore.setState({ status: fresh, error: "new session error", loading: true });
    finish(file(ARCHIVE_RAW));
    await pending;
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(useDistillStore.getState().status).toEqual(fresh);
    expect(useDistillStore.getState().error).toBe("new session error");
    expect(useDistillStore.getState().loading).toBe(true);
  });

  it("keeps the last-started refresh when earlier same-session scanning finishes late", async () => {
    let finish!: (status: DistillStatus) => void;
    const fresh = { ...STATUS, pending_proposals: 9 };
    vi.mocked(ipc.distillStatus)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(fresh);
    const older = useDistillStore.getState().refresh();
    await useDistillStore.getState().refresh();
    expect(useDistillStore.getState().status).toEqual(fresh);
    finish(STATUS);
    await older;
    expect(useDistillStore.getState().status).toEqual(fresh);
    expect(useDistillStore.getState().loading).toBe(false);
  });

  it("passes the original session guard into a map's delayed generation", async () => {
    const raw = PROPOSAL_RAW.replace("action: admit-cluster", "action: draft-map")
      .replace("status: pending", "status: approved")
      .replace(/^payload:.*$/m, 'payload: {"cluster":"synthetic-topic","members":["wiki/a.md"]}');
    vi.spyOn(ipc, "readFile").mockResolvedValue(file(raw));
    const mkdir = vi.spyOn(ipc, "createFolder").mockResolvedValue("/v/wiki/maps");
    const manifest = vi.spyOn(ipc, "appendDistillManifest").mockResolvedValue(null);
    let finish!: (body: string) => void;
    complete.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useDistillStore.getState().apply(rel);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    reopen();
    finish("synthetic generated body");
    expect(await pending).toBeNull();
    expect(mkdir).not.toHaveBeenCalled();
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(manifest).not.toHaveBeenCalled();
    expect(ipc.distillStatus).not.toHaveBeenCalled();
  });

  it("stops a map after native origin capture resolves across a same-path reopen", async () => {
    const raw = PROPOSAL_RAW.replace("action: admit-cluster", "action: draft-map")
      .replace("status: pending", "status: approved")
      .replace(/^payload:.*$/m, 'payload: {"cluster":"synthetic-late-origin","members":["wiki/a.md"]}');
    vi.spyOn(ipc, "readFile").mockResolvedValue(file(raw));
    let finish!: (origin: { vaultPath: string; openingToken: string }) => void;
    const origin = vi.mocked(ipc.agentVaultSession).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = useDistillStore.getState().apply(rel);
    await vi.waitFor(() => expect(origin).toHaveBeenCalledOnce());
    reopen();
    finish({ vaultPath: "/v", openingToken: "synthetic-native-origin" });
    expect(await pending).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(ipc.listFiles).not.toHaveBeenCalled();
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(ipc.distillStatus).not.toHaveBeenCalled();
  });

  it("rejects a different native vault before drafting or publishing a map", async () => {
    const raw = PROPOSAL_RAW.replace("action: admit-cluster", "action: draft-map")
      .replace("status: pending", "status: approved")
      .replace(/^payload:.*$/m, 'payload: {"cluster":"synthetic-native-mismatch","members":["wiki/a.md"]}');
    vi.spyOn(ipc, "readFile").mockResolvedValue(file(raw));
    vi.mocked(ipc.agentVaultSession).mockResolvedValueOnce({ vaultPath: "/other", openingToken: "synthetic-other-native" });
    expect(await useDistillStore.getState().apply(rel)).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(useDistillStore.getState().error).toContain("Vault changed before native publication");
  });

  it("clears proposal state synchronously when the session token changes", () => {
    useDistillStore.setState({ status: STATUS, proposals: [parseProposal(rel, PROPOSAL_RAW)!], error: "old failure", loading: true, needsWriter: true, applying: new Set([rel]) });
    useVaultStore.setState({ vaultToken: "new-session", isOpeningVault: true });
    expect(useDistillStore.getState()).toMatchObject({ status: null, proposals: [], quarantine: [], error: null, loading: false, needsWriter: false });
    expect(useDistillStore.getState().applying.size).toBe(0);
  });

  it("dispatches no proposal IO while native vault opening is in progress", async () => {
    useVaultStore.setState({ isOpeningVault: true });
    const read = vi.spyOn(ipc, "readFile");
    expect(await useDistillStore.getState().apply(rel)).toBeNull();
    expect(await useDistillStore.getState().dismiss(rel)).toBe(false);
    await useDistillStore.getState().refresh();
    expect(read).not.toHaveBeenCalled();
    expect(ipc.distillStatus).not.toHaveBeenCalled();
  });
});

describe("quarantine batch", () => {
  const paths = ["_inbox/quarantine/h1.md", "_inbox/quarantine/h2.md"];
  const group = {
    key: "hello" as const,
    items: paths.map((path) => ({
      path,
      name: path.split("/").pop() ?? "",
      s_knn: 0,
      nearest_cluster: "",
      reason: "machine:hello",
      expires: 0,
      asks_on_expiry: true,
      preview: "",
    })),
  };

  beforeEach(() => {
    useSettingsStore.setState({ settings: { permanent_delete: false } as never, loading: false, saving: false });
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useVaultStore.setState({ isOpeningVault: false });
    useDialogStore.setState({ request: null });
    vi.spyOn(ipc, "distillStatus").mockResolvedValue(STATUS);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "listQuarantine").mockResolvedValue([]);
  });

  it("sends the irreversible policy snapshot with every item and sidecar", async () => {
    const spy = vi.spyOn(ipc, "trashPaths").mockResolvedValue(null);
    await useDistillStore.getState().trashQuarantine(paths, true);
    expect(spy).toHaveBeenCalledWith(expect.arrayContaining(["/v/_inbox/quarantine/h1.md", "/v/_inbox/quarantine/h1.verdict.json"]), true);
  });

  it("restores every item in one call", async () => {
    const spy = vi.spyOn(ipc, "restoreQuarantine").mockResolvedValue("moved 2");
    await useDistillStore.getState().restoreQuarantine(paths);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("/v", paths);
  });

  it("sends every item and its sidecar to the OS trash in one call", async () => {
    const spy = vi.spyOn(ipc, "trashPaths").mockResolvedValue(null);
    await useDistillStore.getState().trashQuarantine(paths);
    expect(spy.mock.calls).toEqual([
      [
        [
          "/v/_inbox/quarantine/h1.md",
          "/v/_inbox/quarantine/h1.verdict.json",
          "/v/_inbox/quarantine/h2.md",
          "/v/_inbox/quarantine/h2.verdict.json",
        ],
      ],
    ]);
  });

  it("trashes a big group in a few calls and shows it shrink between them", async () => {
    // One trash call is one Finder request on macOS (~80 ms and a sound):
    // the measured 106-item group must not cost 212 of them.
    const many = Array.from({ length: 106 }, (_, i) => `_inbox/quarantine/m${i}.md`);
    const spy = vi.spyOn(ipc, "trashPaths").mockResolvedValue(null);
    const list = vi.spyOn(ipc, "listQuarantine").mockResolvedValue([]);
    await useDistillStore.getState().trashQuarantine(many);
    expect(spy.mock.calls.map(([p]) => p.length)).toEqual([100, 100, 12]);
    expect(spy.mock.calls.flatMap(([p]) => p).filter((p) => p.endsWith(".md")).length).toBe(106);
    // A refresh after each call, so the counts go down while it runs.
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("does nothing until the in-page confirmation is accepted", async () => {
    const trash = vi.spyOn(ipc, "trashPaths").mockResolvedValue(null);
    const pending = confirmQuarantineBatch("trash", group, STRINGS.ko);
    // The modal is open and nothing has moved yet.
    await Promise.resolve();
    const req = useDialogStore.getState().request;
    expect(req?.kind).toBe("confirm");
    expect(req?.danger).toBe(true);
    expect(trash).not.toHaveBeenCalled();
    useDialogStore.getState().close(null);
    expect(await pending).toBe(false);
    expect(trash).not.toHaveBeenCalled();
  });

  it("holds a group's lock until its own batch ends, whatever finishes meanwhile", async () => {
    let release = (): void => undefined;
    const batch = withQuarantineLock("hello", () => new Promise<void>((r) => (release = r)));
    // A card in another group restores and finishes while the batch runs.
    await withQuarantineLock("_inbox/quarantine/other.md", async () => undefined);
    expect([...useDistillStore.getState().quarantineBusy]).toEqual(["hello"]);
    // A second batch on the same group does nothing while the first runs.
    const again = vi.fn(async () => undefined);
    await withQuarantineLock("hello", again);
    expect(again).not.toHaveBeenCalled();
    release();
    await batch;
    expect(useDistillStore.getState().quarantineBusy.size).toBe(0);
  });

  it("locks the group only once the owner confirms", async () => {
    let release = (): void => undefined;
    vi.spyOn(ipc, "restoreQuarantine").mockImplementation(
      () => new Promise<string>((r) => (release = () => r("moved 2"))),
    );
    const pending = confirmQuarantineBatch("restore", group, STRINGS.en);
    await Promise.resolve();
    // Unlocked under the dialog: the opener stays enabled, so focus can go
    // back to it when the dialog closes.
    expect(useDialogStore.getState().request?.kind).toBe("confirm");
    expect(useDistillStore.getState().quarantineBusy.has("hello")).toBe(false);
    useDialogStore.getState().close("ok");
    await vi.waitFor(() =>
      expect(useDistillStore.getState().quarantineBusy.has("hello")).toBe(true),
    );
    release();
    expect(await pending).toBe(true);
    expect(useDistillStore.getState().quarantineBusy.has("hello")).toBe(false);
  });

  it("acts on the whole group once the confirmation is accepted", async () => {
    const restore = vi.spyOn(ipc, "restoreQuarantine").mockResolvedValue("moved 2");
    const pending = confirmQuarantineBatch("restore", group, STRINGS.en);
    await Promise.resolve();
    expect(useDialogStore.getState().request?.danger).toBe(false);
    useDialogStore.getState().close("ok");
    expect(await pending).toBe(true);
    expect(restore).toHaveBeenCalledWith("/v", paths);
  });
});

it("describes approved deletion proposals using the actual irreversible policy", () => {
  const proposal = { action: "delete-batch", files: ["_inbox/quarantine/a.md"] } as ProposalMeta;
  expect(proposalOutcome(proposal, STRINGS.ko, true)).toBe(STRINGS.ko.delete_permanent_msg.replace("{n}", "1"));
});
