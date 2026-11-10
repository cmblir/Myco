import { beforeEach, expect, it, vi } from "vitest";
import { refreshExistingMap } from "./mapRefresh";
import { roleFixture } from "./modelRoles.testSupport";
import { sha256 } from "./tidyRun";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const origin = { vaultPath: "/synthetic", openingToken: "synthetic-refresh-opening" };
const role = roleFixture("organization", "builtin-local", "synthetic-model", origin);
const path = "wiki/maps/synthetic.md";
let current = "Synthetic before.\nHuman note.\n";
const after = "Synthetic after.\nHuman note.\n";
beforeEach(() => {
  current = "Synthetic before.\nHuman note.\n";
  invoke.mockReset().mockImplementation(async command => {
    if (command === "preview_map_refresh") return { path, content: after, currentRevision: await sha256(current) };
    if (command === "read_file") return { raw: current };
    if (command === "apply_map_refresh") return { path, revision: await sha256(after), changed: true };
    throw new Error(`Unexpected synthetic command ${command}`);
  });
});
const run = (review: () => Promise<boolean>, assertCurrent = () => undefined, recheck = async () => undefined) =>
  refreshExistingMap(origin, role, path, "Synthetic candidate", "c".repeat(64), review, assertCurrent, recheck);

it("reviews native bytes and sends the original source grant and CAS through the real IPC adapter", async () => {
  const review = vi.fn(async () => true);
  const recheck = vi.fn(async () => undefined);
  await expect(run(review, undefined, recheck)).resolves.toBe(path);
  expect(review).toHaveBeenCalledWith({ path, before: current, after });
  expect(recheck).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenLastCalledWith("apply_map_refresh", { origin, roleSnapshot: role, key: "synthetic",
    candidate: "Synthetic candidate", sourceSnapshotId: "c".repeat(64), expectedSha256: await sha256(current) });
});
it("never writes after cancellation, a vault switch, or failed source recheck", async () => {
  await expect(run(async () => false)).rejects.toMatchObject({ status: "stopped" });
  let active = true;
  await expect(run(async () => { active = false; return true; }, () => { if (!active) throw new Error("Vault changed"); })).rejects.toThrow("Vault changed");
  await expect(run(async () => true, undefined, async () => { throw new Error("Sources changed"); })).rejects.toThrow("Sources changed");
  expect(invoke.mock.calls.some(([command]) => command === "apply_map_refresh")).toBe(false);
});
it("rejects changed review input and an inconsistent native result", async () => {
  invoke.mockImplementationOnce(async () => ({ path, content: after, currentRevision: "0".repeat(64) }));
  const review = vi.fn(async () => true);
  await expect(run(review)).rejects.toMatchObject({ status: "pending" });
  expect(review).not.toHaveBeenCalled();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (...args) => args[0] === "apply_map_refresh"
    ? { path, revision: await sha256(after), changed: false } : original(...args));
  await expect(run(review)).rejects.toMatchObject({ status: "pending" });
});

it("uses approved-proposal routing without fabricating review or skipping source checks", async () => {
  const recheck = vi.fn(async () => undefined);
  await expect(refreshExistingMap(origin, role, path, "Synthetic candidate", "c".repeat(64), { kind: "approved-proposal", recheck: async () => undefined }, () => undefined, recheck)).resolves.toBe(path);
  expect(recheck).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["preview_map_refresh", "read_file", "apply_map_refresh"]);
});

it.each(["map refresh bytes persisted but verification failed: synthetic", "compiler canonical persisted but admission incomplete; synthetic"])("reports native retained output as incomplete: %s", async message => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (...args) => {
    if (args[0] === "apply_map_refresh") throw message;
    return original(...args);
  });
  await expect(run(async () => true)).rejects.toMatchObject({ status: "pending", writtenPath: path });
});

it("does not claim a retained write for a stale target rejection", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (...args) => {
    if (args[0] === "apply_map_refresh") throw new Error("map revision changed since preview");
    return original(...args);
  });
  try { await run(async () => true); throw new Error("Expected rejection"); }
  catch (error) {
    expect(error).toMatchObject({ status: "pending" });
    expect(error).not.toHaveProperty("writtenPath");
  }
});

it("rejects a withdrawn automatic approval before native apply", async () => {
  await expect(refreshExistingMap(origin, role, path, "Synthetic candidate", "c".repeat(64), {
    kind: "approved-proposal", recheck: async () => { throw new Error("Approval withdrawn"); },
  }, () => undefined, async () => undefined)).rejects.toThrow("Approval withdrawn");
  expect(invoke.mock.calls.some(([command]) => command === "apply_map_refresh")).toBe(false);
});
