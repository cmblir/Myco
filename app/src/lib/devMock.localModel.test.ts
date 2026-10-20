import { beforeAll, describe, expect, it } from "vitest";
import { installTauriMock } from "./devMock";
import { BUILTIN_CHAT_MODEL } from "./providers";
import type { LocalChatStatus, LocalSynthesisResult } from "./ipc";

function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const surface = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<T> } };
  return surface.__TAURI_INTERNALS__.invoke(command, args);
}

beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;
  installTauriMock();
});

describe("devMock local synthesis contract", () => {
  it("does not claim a model was installed or downloaded in a browser", async () => {
    await expect(invoke<LocalChatStatus>("local_chat_status")).resolves.toEqual({ model_id: BUILTIN_CHAT_MODEL, state: "missing", bytes: 0 });
    await expect(invoke<LocalChatStatus>("download_local_chat_model")).resolves.toEqual({
      model_id: BUILTIN_CHAT_MODEL, state: "error", bytes: 0, reason: "mock_download_unavailable",
    });
    await expect(invoke<LocalChatStatus>("local_chat_status")).resolves.toMatchObject({ state: "missing", bytes: 0 });
  });

  it("declines synthesis instead of returning a fake local-model answer", async () => {
    await expect(invoke<LocalSynthesisResult>("local_synthesize", { request: {
      requestId: "synthetic-request", expectedVault: "/myco", question: "Synthetic question", lang: "en", scope: "wiki", hits: [],
    } })).resolves.toEqual({ answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "mock_inference_unavailable" });
    await expect(invoke("cancel_local_synthesis", { requestId: "synthetic-request" })).resolves.toBe(false);
    await expect(invoke("cancel_local_chat_model_download")).resolves.toBe(false);
  });
});
