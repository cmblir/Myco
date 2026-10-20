import { beforeAll, beforeEach, expect, it } from "vitest";
import { installTauriMock } from "./devMock";
import type { AgentVaultSession } from "./ipc";
import type { QuarantineItem } from "./quarantine";

// The development-only memory demo is not evidence of native filesystem safety.
function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const surface = window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, input: unknown) => Promise<T> } };
  return surface.__TAURI_INTERNALS__.invoke(command, args);
}

let origin: AgentVaultSession;
beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;
  installTauriMock();
});
beforeEach(async () => {
  await invoke("open_vault", { path: "/myco" });
  origin = await invoke<AgentVaultSession>("agent_vault_session");
});

async function inventory() {
  return structuredClone(await invoke<QuarantineItem[]>("list_quarantine", { vault: "/myco" }));
}

it("extends only the selected current-opening item in the memory demo", async () => {
  const before = await inventory();
  const item = before.find((entry) => entry.expires > Math.floor(Date.now() / 1000));
  expect(item).toBeDefined();
  const files = [item!.path];
  await invoke("extend_quarantine", { vault: "/myco", files, days: 7, origin });
  const after = await inventory();
  expect(after).toEqual(before.map((entry) => entry.path === item!.path ? { ...entry, expires: entry.expires + 7 * 86400 } : entry));
});

it.each(["missing", "empty", "child", "reopened", "closed"])("refuses a %s opening before demo mutation", async (mode) => {
  const before = await inventory();
  if (mode === "reopened") await invoke("open_vault", { path: "/myco" });
  if (mode === "closed") await invoke("close_vault");
  const requestOrigin = mode === "missing" ? undefined : mode === "empty" ? { ...origin, openingToken: "" } : origin;
  await expect(invoke("extend_quarantine", {
    vault: mode === "child" ? "/myco/child" : "/myco", files: before.map((entry) => entry.path), days: 7, origin: requestOrigin,
  })).rejects.toThrow("opening");
  expect(await inventory()).toEqual(before);
});
