import { beforeEach, expect, it, vi } from "vitest";
import { evidenceSection, sourceEvidence } from "./sessionEvidence";
import { sha256 } from "./tidyRun";
import type { AgentVaultSession } from "./ipc";
import type { RoleId, RoleUsage } from "./modelRoles";
import { roleFixture } from "./modelRoles.testSupport";

// Mocked IPC exercises producer routing/accounting; native filesystem authority
// is covered independently by distill_publication_boundary_tests.rs.
const mocks = vi.hoisted(() => ({
  role: vi.fn(), origin: vi.fn(), publish: vi.fn(), archive: vi.fn(), append: vi.fn(),
  read: vi.fn(), write: vi.fn(), conditional: vi.fn(), complete: vi.fn(),
}));
vi.mock("./ipc", () => ({ ipc: {
  agentVaultSession: (...args: unknown[]) => mocks.origin(...args),
  captureModelRole: (...args: unknown[]) => mocks.role(...args),
  publishDistillNote: (...args: unknown[]) => mocks.publish(...args),
  archiveDigestedSessions: (...args: unknown[]) => mocks.archive(...args),
  appendDistillManifest: (...args: unknown[]) => mocks.append(...args),
  readFile: (...args: unknown[]) => mocks.read(...args),
  writeFile: (...args: unknown[]) => mocks.write(...args),
  writeFileIfUnchanged: (...args: unknown[]) => mocks.conditional(...args),
  createFolder: async () => "synthetic",
  listFiles: async () => [],
  getDistillConfig: async () => ({ llm_digest_days: 1 }),
  getSettings: async () => ({ ingest_provider: "builtin-local", ingest_model: "extractive-ingest" }),
  digestableSessionDays: async () => [{ day: "2026-08-10", files: ["sessions/2026-08-10/a.md"] }],
} }));
vi.mock("./chat", () => ({
  complete: (...args: unknown[]) => mocks.complete(...args),
  getActiveModel: async () => ({ provider: "anthropic-api", model: "synthetic" }),
}));
vi.mock("../stores/uiStore", () => ({ useUIStore: { getState: () => ({ lang: "en" }) } }));

const ORIGIN = { vaultPath: "/v", openingToken: "synthetic-opening" };
const RAW = "The synthetic project retained the original source and completed an implementation review.";
let notes: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
  notes = new Map([["/v/sessions/2026-08-10/a.md", RAW]]);
  mocks.origin.mockResolvedValue(ORIGIN);
  mocks.role.mockImplementation(async (origin: AgentVaultSession, role: RoleId, usage: RoleUsage) => {
    expect(role).toBe("organization");
    return roleFixture(role, "anthropic-api", "synthetic", origin, usage);
  });
  mocks.complete.mockResolvedValue("- Completed a synthetic implementation review.");
  mocks.read.mockImplementation(async (path: string) => {
    if (!notes.has(path)) throw new Error("ENOENT: no such file or directory");
    return { raw: notes.get(path), frontmatter: null };
  });
  mocks.write.mockImplementation(async (path: string, content: string) => { notes.set(path, content); });
  mocks.conditional.mockImplementation(async (path: string, content: string) => { notes.set(path, content); });
  mocks.publish.mockImplementation(async (_origin, operationId: string, artifact: { kind: string; key: string }, content: string, expected: string | null) => {
    const path = artifact.kind === "map" ? `wiki/maps/${artifact.key}.md` : `${artifact.kind}/${artifact.key}.md`;
    notes.set(`/v/${path}`, content);
    return { publicationId: "b".repeat(64), operationId, path, revision: await sha256(content),
      nativeCreated: expected === null, state: "published", fileIdentity: { device: 1, inode: 2, changedSeconds: 3, changedNanoseconds: 4 } };
  });
  mocks.archive.mockImplementation(async (_vault, _day, paths: string[], _revisions, options) => ({
    manifestId: options.manifestId, moved: paths.map(from => ({ from, to: `archive/${from}`, revision: "a".repeat(64) })),
    pending: [], skipped: [], createdNotePaths: [], retryable: true,
  }));
  mocks.append.mockResolvedValue(null);
});

it("routes a new digest through the native issuer and forwards its opaque ID", async () => {
  const { runSessionDigest } = await import("./sessionDigest");
  const outcome = await runSessionDigest("/v");
  expect(outcome.filesArchived).toBe(1);
  expect(mocks.publish).toHaveBeenCalledOnce();
  expect(mocks.archive.mock.calls[0][4]).toMatchObject({ origin: ORIGIN, publicationIds: ["b".repeat(64)] });
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.conditional).not.toHaveBeenCalled();
});

it("preserves a fully covered legacy digest without inventing creation authority", async () => {
  const source = sourceEvidence("sessions/2026-08-10/a.md", RAW, "2026-08-10");
  notes.set("/v/daily/2026-08-10.md", "# Legacy\n" + evidenceSection([source], source.chunks));
  const { runSessionDigest } = await import("./sessionDigest");
  expect(await runSessionDigest("/v")).toMatchObject({ filesArchived: 0, filesPending: 1, status: "pending" });
  expect(mocks.archive).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("does not archive sources after an existing human note update", async () => {
  notes.set("/v/daily/2026-08-10.md", "# Human note\nPreserve this annotation.\n");
  const { runSessionDigest } = await import("./sessionDigest");
  expect(await runSessionDigest("/v")).toMatchObject({ filesArchived: 0, filesPending: 1, status: "partial" });
  expect(notes.get("/v/daily/2026-08-10.md")).toContain("Preserve this annotation.");
  expect(mocks.archive).not.toHaveBeenCalled();
  expect(mocks.publish.mock.calls[0][4]).toEqual(await sha256("# Human note\nPreserve this annotation.\n"));
});

it("rejects a missing opening token before publishing or archiving", async () => {
  mocks.origin.mockResolvedValue({ vaultPath: "/v", openingToken: "" });
  const { runSessionDigest } = await import("./sessionDigest");
  await expect(runSessionDigest("/v")).rejects.toMatchObject({ code: "validation_rejected" });
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.archive).not.toHaveBeenCalled();
  expect(mocks.conditional).not.toHaveBeenCalled();
});

it("creates a map through the native issuer and records its opaque ID", async () => {
  const { draftMap } = await import("./maps");
  await expect(draftMap("/v", "synthetic-topic", ["wiki/a.md"], "llm-123")).resolves.toBe("wiki/maps/synthetic-topic.md");
  expect(mocks.publish).toHaveBeenCalledWith(ORIGIN, "llm-123", { kind: "map", key: "synthetic-topic" }, expect.any(String), null,
    roleFixture("organization", "anthropic-api", "synthetic", ORIGIN));
  expect(mocks.append.mock.calls[0][6]).toEqual(["b".repeat(64)]);
  expect(mocks.write).not.toHaveBeenCalled();
});

it("retries an archive with the original native ID without regenerating the note", async () => {
  mocks.archive.mockRejectedValueOnce(new Error("synthetic journal unavailable"));
  const { runSessionDigest } = await import("./sessionDigest");
  expect(await runSessionDigest("/v")).toMatchObject({ filesArchived: 0, status: "partial" });
  expect(await runSessionDigest("/v")).toMatchObject({ filesArchived: 1 });
  expect(mocks.publish).toHaveBeenCalledOnce();
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(mocks.archive.mock.calls[1][4]).toEqual(mocks.archive.mock.calls[0][4]);
});

it("does not reuse an old opening's cached authority after a same-path reopen", async () => {
  mocks.archive.mockRejectedValueOnce(new Error("synthetic journal unavailable"));
  const { runSessionDigest } = await import("./sessionDigest");
  await runSessionDigest("/v");
  mocks.origin.mockResolvedValue({ ...ORIGIN, openingToken: "synthetic-reopened" });
  expect(await runSessionDigest("/v")).toMatchObject({ filesArchived: 0, status: "pending", filesPending: 1 });
  expect(mocks.publish).toHaveBeenCalledOnce();
  expect(mocks.archive).toHaveBeenCalledOnce();
});

it("does not recreate authority from identical bytes after a frontend restart", async () => {
  mocks.archive.mockRejectedValueOnce(new Error("synthetic journal unavailable"));
  const first = await import("./sessionDigest");
  await first.runSessionDigest("/v");
  vi.resetModules();
  const restarted = await import("./sessionDigest");
  expect(await restarted.runSessionDigest("/v")).toMatchObject({ filesArchived: 0, status: "pending", filesPending: 1 });
  expect(mocks.publish).toHaveBeenCalledOnce();
  expect(mocks.archive).toHaveBeenCalledOnce();
});

it("rejects a malformed issuer receipt without submitting a SHA-only archive", async () => {
  mocks.publish.mockResolvedValue({ nativeCreated: true, publicationId: "" });
  const { runSessionDigest } = await import("./sessionDigest");
  expect(await runSessionDigest("/v")).toMatchObject({ filesArchived: 0, filesPending: 1, status: "pending" });
  expect(mocks.archive).not.toHaveBeenCalled();
});

it("preserves outputs when native identity verification rejects an archive retry", async () => {
  mocks.archive.mockRejectedValue(new Error("same-content inode replacement; manual recovery required"));
  const { runSessionDigest } = await import("./sessionDigest");
  await runSessionDigest("/v");
  expect(await runSessionDigest("/v")).toMatchObject({ filesArchived: 0, filesPending: 1 });
  expect(mocks.publish).toHaveBeenCalledOnce();
  expect(notes.has("/v/daily/2026-08-10.md")).toBe(true);
  expect(notes.has("/v/sessions/2026-08-10/a.md")).toBe(true);
});

it("leaves a map pending when the issuer returns nativeCreated false", async () => {
  const issue = mocks.publish.getMockImplementation()!;
  mocks.publish.mockImplementation(async (...args) => ({ ...await issue(...args), nativeCreated: false }));
  const { draftMap } = await import("./maps");
  await expect(draftMap("/v", "synthetic-human-map", ["wiki/a.md"], "llm-123")).rejects.toMatchObject({ status: "pending" });
  expect(mocks.append).not.toHaveBeenCalled();
  expect(notes.has("/v/wiki/maps/synthetic-human-map.md")).toBe(true);
});
