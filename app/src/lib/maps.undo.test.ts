import { beforeEach, expect, it, vi } from "vitest";
import { ipc, type AgentVaultSession, type DistillPublicationReceipt } from "./ipc";
import { draftMap } from "./maps";
import { roleFixture } from "./modelRoles.testSupport";
import { sha256 } from "./tidyRun";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), complete: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./chat", () => ({ complete: mocks.complete }));
let origin: AgentVaultSession = { vaultPath: "/synthetic", openingToken: "" };
let sequence = 0;
let undoFails = false;

beforeEach(() => {
  origin = { ...origin, openingToken: `synthetic-map-undo-${++sequence}` };
  undoFails = false;
  mocks.complete.mockReset().mockResolvedValue("Synthetic relationship [[wiki/a.md|a]].");
  const notes = new Map<string, string>();
  const publications = new Map<string, DistillPublicationReceipt>();
  const consumed = new Set<string>();
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "agent_vault_session": return { ...origin };
      case "capture_model_role": return roleFixture("organization", "builtin-local", "synthetic-model", origin);
      case "capture_map_sources": {
        const raw = "Synthetic evidence.";
        return { snapshotId: "c".repeat(64), origin: { ...origin }, members: [{ path: "wiki/a.md", raw, revision: await sha256(raw) }] };
      }
      case "check_map_sources": case "release_map_sources": return undefined;
      case "list_files": return [];
      case "read_file": {
        const raw = notes.get(args.path as string);
        if (raw === undefined) throw new Error("ENOENT");
        return { raw, content: raw, frontmatter: {} };
      }
      case "publish_distill_note": {
        const operationId = args.operationId as string;
        if (consumed.has(operationId)) throw new Error("synthetic operation already consumed");
        const path = `wiki/maps/${(args.artifact as { key: string }).key}.md`;
        const content = args.content as string;
        if (notes.has(`${origin.vaultPath}/${path}`)) throw new Error("synthetic absence CAS rejected");
        notes.set(`${origin.vaultPath}/${path}`, content);
        const receipt: DistillPublicationReceipt = { publicationId: await sha256(operationId), operationId, path,
          revision: await sha256(content), nativeCreated: true, state: "published",
          fileIdentity: { device: 1, inode: publications.size + 1, changedSeconds: 1, changedNanoseconds: 0 } };
        publications.set(operationId, receipt);
        return receipt;
      }
      case "append_distill_manifest": {
        if (consumed.has(args.id as string)) throw new Error("synthetic publication already consumed");
        return undefined;
      }
      case "undo_distill_run": {
        if (undoFails) throw new Error("synthetic undo unavailable");
        const id = args.id as string;
        const publication = publications.get(id);
        if (!publication) throw new Error("synthetic unknown publication");
        notes.delete(`${origin.vaultPath}/${publication.path}`);
        consumed.add(id);
        return 1;
      }
      default: throw new Error(`Unexpected synthetic command: ${command}`);
    }
  });
});

it("generates again after the real undo adapter confirms removal", async () => {
  const first = await draftMap(origin.vaultPath, "synthetic-topic", ["wiki/a.md"], "llm-100");
  expect(await ipc.undoDistillRun(origin.vaultPath, "llm-100")).toBe(1);
  await expect(draftMap(origin.vaultPath, "synthetic-topic", ["wiki/a.md"], "llm-200")).resolves.toBe(first);
  expect(mocks.complete).toHaveBeenCalledTimes(2);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "publish_distill_note").map(([, args]) => args.operationId))
    .toEqual(["llm-100", "llm-200"]);
});

it("keeps publication recovery when native undo fails", async () => {
  const first = await draftMap(origin.vaultPath, "synthetic-topic", ["wiki/a.md"], "llm-100");
  undoFails = true;
  await expect(ipc.undoDistillRun(origin.vaultPath, "llm-100")).rejects.toThrow("synthetic undo unavailable");
  await expect(draftMap(origin.vaultPath, "synthetic-topic", ["wiki/a.md"], "llm-200")).resolves.toBe(first);
  expect(mocks.complete).toHaveBeenCalledOnce();
});


it("uses a fresh default run identity when undo and regeneration occur in the same second", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  try {
    await draftMap(origin.vaultPath, "synthetic-default", ["wiki/a.md"]);
    const firstRun = mocks.invoke.mock.calls.find(([command]) => command === "publish_distill_note")![1].operationId as string;
    await ipc.undoDistillRun(origin.vaultPath, firstRun);
    await draftMap(origin.vaultPath, "synthetic-default", ["wiki/a.md"]);
    const runs = mocks.invoke.mock.calls.filter(([command]) => command === "publish_distill_note").map(([, args]) => args.operationId);
    expect(new Set(runs).size).toBe(2);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});
