import { beforeAll, expect, it } from "vitest";
import { installTauriMock } from "./devMock";

function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const surface = window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, input: unknown) => Promise<T> } };
  return surface.__TAURI_INTERNALS__.invoke(command, args);
}

beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;
  installTauriMock();
});

it("declines every native authority command without fabricating publication or changing demo content", async () => {
  const before = await invoke("read_vault_context", { vault: "/myco", budget: 80_000 });
  for (const command of ["capture_model_role", "select_model_role", "set_role_automatic_use", "publish_distill_note", "session_compile_begin", "session_compile_read", "session_compile_publish", "session_compile_step", "session_compile_stop", "inbox_source_snapshot", "inbox_compile_begin", "archive_inbox_source_checked", "release_inbox_source"]) {
    await expect(invoke(command, { origin: { vaultPath: "/myco", openingToken: "synthetic" }, nativeCreated: true, semanticReviewPassed: true, content: "Synthetic forged completion." })).rejects.toThrow("NATIVE_CAPABILITY_UNAVAILABLE");
  }
  expect(await invoke("read_vault_context", { vault: "/myco", budget: 80_000 })).toEqual(before);
});
