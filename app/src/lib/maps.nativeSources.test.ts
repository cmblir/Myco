import { beforeEach, expect, it, vi } from "vitest";
import { roleFixture } from "./modelRoles.testSupport";
import { sha256 } from "./tidyRun";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), check: vi.fn(), release: vi.fn(), complete: vi.fn(), publish: vi.fn(), read: vi.fn() }));
const origin = { vaultPath: "/v", openingToken: "synthetic-map-opening" };
const role = roleFixture("organization", "builtin-local", "synthetic-model", origin);
vi.mock("./ipc", () => ({ ipc: {
  agentVaultSession: async () => origin,
  captureModelRole: async () => role,
  captureMapSources: (...args: unknown[]) => mocks.capture(...args),
  checkMapSources: (...args: unknown[]) => mocks.check(...args),
  releaseMapSources: (...args: unknown[]) => mocks.release(...args),
  readFile: (...args: unknown[]) => mocks.read(...args),
  listFiles: async () => [],
  publishDistillNote: (...args: unknown[]) => mocks.publish(...args),
  appendDistillManifest: async () => undefined,
} }));
vi.mock("./chat", () => ({ complete: (...args: unknown[]) => mocks.complete(...args) }));

let sequence = 0;
beforeEach(async () => {
  vi.resetModules();
  origin.openingToken = `synthetic-map-opening-${++sequence}`;
  for (const mock of Object.values(mocks)) mock.mockReset();
  const raw = "Synthetic evidence requires a human review.";
  mocks.capture.mockResolvedValue({ snapshotId: "c".repeat(64), origin, members: [{ path: "wiki/a.md", raw, revision: await sha256(raw) }] });
  mocks.check.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.read.mockImplementation(async (path: string) => {
    if (path === "/v/wiki/a.md") return { raw };
    throw new Error("ENOENT");
  });
  mocks.complete.mockResolvedValue("A human review is required. [[wiki/a.md|a]]");
  mocks.publish.mockImplementation(async (_origin, operationId, artifact, content) => ({
    publicationId: "b".repeat(64), operationId, path: `wiki/maps/${artifact.key}.md`,
    revision: await sha256(content), nativeCreated: true, state: "published",
    fileIdentity: { device: 1, inode: 2, changedSeconds: 3, changedNanoseconds: 4 },
  }));
});

it("uses one organization-bound native source grant, checks it before publishing and releases it", async () => {
  const { draftMap } = await import("./maps");
  await draftMap("/v", "synthetic", ["wiki/a.md"]);
  expect(mocks.capture).toHaveBeenCalledWith(origin, role, ["wiki/a.md"]);
  expect(mocks.check).toHaveBeenCalledWith(origin, role, "c".repeat(64));
  expect(mocks.check.mock.invocationCallOrder[0]).toBeLessThan(mocks.publish.mock.invocationCallOrder[0]);
  expect(mocks.release).toHaveBeenCalledWith(origin, "c".repeat(64));
  expect(mocks.read).not.toHaveBeenCalledWith("/v/wiki/a.md");
});

it("does not fall back to a generic source read if native capture is unavailable", async () => {
  mocks.capture.mockRejectedValue(new Error("native source snapshots unavailable"));
  const { draftMap } = await import("./maps");
  await expect(draftMap("/v", "synthetic", ["wiki/a.md"])).rejects.toThrow("unavailable");
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalledWith("/v/wiki/a.md");
});

it.each(["complete", "check", "publish"] as const)("releases a captured source after %s fails", async step => {
  mocks[step].mockRejectedValue(new Error(`synthetic ${step} failure`));
  const { draftMap } = await import("./maps");
  await expect(draftMap("/v", "synthetic", ["wiki/a.md"])).rejects.toThrow(step);
  expect(mocks.release).toHaveBeenCalledOnce();
  if (step !== "publish") expect(mocks.publish).not.toHaveBeenCalled();
});

it("releases a late capture even when its originating view was cancelled", async () => {
  let current = true;
  const snapshot = await mocks.capture();
  mocks.capture.mockClear().mockImplementation(async () => { current = false; return snapshot; });
  const { draftMap } = await import("./maps");
  await expect(draftMap("/v", "synthetic", ["wiki/a.md"], "synthetic-run", () => current)).rejects.toThrow("Vault changed");
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(mocks.complete).not.toHaveBeenCalled();
});
