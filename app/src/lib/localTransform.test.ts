import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { BUILTIN_CHAT_MODEL, BUILTIN_FAST_CHAT_MODEL } from "./providers";
import { sourceEvidence } from "./sessionEvidence";
import { roleFixture, syntheticOrigin } from "./modelRoles.testSupport";
import { LocalTransformSourceError, selectedLocalOrganizeModel, selectedLocalTransformModel, tryLocalTransform } from "./localTransform";

vi.mock("./ipc", () => ({ ipc: { localTransform: vi.fn(), cancelLocalSynthesis: vi.fn(),
  agentVaultSession: vi.fn(), captureModelRole: vi.fn() } }));

const raw = Array.from({ length: 12 }, (_, i) => `**User:**\n\nSynthetic statement ${i}: this proposed task has no completion record.`).join("\n\n");
const source = sourceEvidence("raw/synthetic.md", raw, "2026-10-05");
const options = { batch: source.chunks, vaultPath: "/v", kind: "ingest" as const,
  modelId: BUILTIN_CHAT_MODEL, lang: "en" as const };
const answer = "The source records a proposal, without completion evidence. [[raw/synthetic]]";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.agentVaultSession).mockResolvedValue(syntheticOrigin);
  vi.mocked(ipc.captureModelRole).mockImplementation(async (origin, role, usage) =>
    roleFixture(role, "builtin-local", BUILTIN_CHAT_MODEL, origin, usage));
  vi.mocked(ipc.localTransform).mockResolvedValue({ answer, model_id: BUILTIN_CHAT_MODEL, used_sources: ["raw/synthetic.md"], selected_chunks: 6 });
  vi.mocked(ipc.cancelLocalSynthesis).mockResolvedValue(true);
});

describe("bounded local transforms", () => {
  it("uses the organization's own selection without inheriting a compilation generator", () => {
    const ingest = { ingest_provider: "builtin-local", ingest_model: BUILTIN_FAST_CHAT_MODEL };
    expect(selectedLocalOrganizeModel({ provider: "builtin-local", model: BUILTIN_CHAT_MODEL }, ingest)).toBe(BUILTIN_CHAT_MODEL);
    expect(selectedLocalOrganizeModel({ provider: "builtin-local", model: "extractive-retrieval" }, ingest)).toBeUndefined();
    expect(selectedLocalOrganizeModel({ provider: "builtin-local", model: BUILTIN_FAST_CHAT_MODEL }, ingest)).toBe(BUILTIN_FAST_CHAT_MODEL);
    expect(selectedLocalOrganizeModel({ provider: "anthropic-cli", model: "sonnet" }, ingest)).toBeUndefined();
    expect(selectedLocalOrganizeModel({ provider: "builtin-local", model: BUILTIN_CHAT_MODEL },
      { ingest_provider: "ollama", ingest_model: BUILTIN_FAST_CHAT_MODEL })).toBe(BUILTIN_CHAT_MODEL);
    expect(selectedLocalOrganizeModel({ provider: "builtin-local", model: BUILTIN_CHAT_MODEL },
      { ingest_provider: "builtin-local", ingest_model: "extractive-ingest" })).toBe(BUILTIN_CHAT_MODEL);
    expect(selectedLocalOrganizeModel({ provider: "builtin-local", model: "extractive-retrieval" },
      { ingest_provider: "builtin-local", ingest_model: "extractive-ingest" })).toBeUndefined();
    expect(selectedLocalOrganizeModel({ provider: "builtin-local", model: BUILTIN_CHAT_MODEL }, null)).toBe(BUILTIN_CHAT_MODEL);
  });
  it("passes six original chunks, their full-source revisions and the selected model", async () => {
    const preview = await tryLocalTransform(options);
    expect(preview).toEqual({ text: answer, modelId: BUILTIN_CHAT_MODEL, selectedChunks: 6, totalChunks: 12 });
    expect(ipc.localTransform).toHaveBeenCalledWith(expect.objectContaining({ expectedVault: "/v", kind: "ingest",
      modelId: BUILTIN_CHAT_MODEL, lang: "en", sources: source.chunks.slice(0, 6).map(chunk => ({
        page: chunk.source, revision: source.revision, text: chunk.text,
      })) }));
    expect(vi.mocked(ipc.localTransform).mock.calls[0][0].sources.every(item => item.text.length <= 600)).toBe(true);
  });

  it("honors an explicitly selected recognized fast model without changing the default", async () => {
    vi.mocked(ipc.captureModelRole).mockImplementation(async (origin, role, usage) =>
      roleFixture(role, "builtin-local", BUILTIN_FAST_CHAT_MODEL, origin, usage));
    vi.mocked(ipc.localTransform).mockResolvedValue({ answer, model_id: BUILTIN_FAST_CHAT_MODEL, used_sources: ["raw/synthetic.md"], selected_chunks: 6 });
    expect((await tryLocalTransform({ ...options, modelId: BUILTIN_FAST_CHAT_MODEL }))?.modelId).toBe(BUILTIN_FAST_CHAT_MODEL);
    expect(ipc.localTransform).toHaveBeenCalledWith(expect.objectContaining({ modelId: BUILTIN_FAST_CHAT_MODEL }));
  });

  it("does not opt in quote-only, unknown, or empty inputs", async () => {
    expect(selectedLocalTransformModel("builtin-local", BUILTIN_CHAT_MODEL)).toBe(BUILTIN_CHAT_MODEL);
    expect(selectedLocalTransformModel("anthropic-cli", BUILTIN_CHAT_MODEL)).toBeUndefined();
    expect(selectedLocalTransformModel("builtin-local", "extractive-ingest")).toBeUndefined();
    expect(await tryLocalTransform({ ...options, modelId: undefined })).toBeNull();
    expect(await tryLocalTransform({ ...options, modelId: "extractive-ingest" })).toBeNull();
    expect(await tryLocalTransform({ ...options, modelId: "remote-model" })).toBeNull();
    expect(await tryLocalTransform({ ...options, batch: [] })).toBeNull();
    expect(ipc.localTransform).not.toHaveBeenCalled();
  });

  it("reports the actual native token-budget subset rather than all six offered chunks", async () => {
    vi.mocked(ipc.localTransform).mockResolvedValue({ answer, model_id: BUILTIN_CHAT_MODEL, used_sources: ["raw/synthetic.md"], selected_chunks: 2 });
    expect(await tryLocalTransform(options)).toEqual({ text: answer, modelId: BUILTIN_CHAT_MODEL, selectedChunks: 2, totalChunks: 12 });
  });

  it("does not submit receipt-normalized gaps as verbatim original excerpts", async () => {
    const original = "An earlier proposed change.\n<!-- myco:digested-sessions synthetic:aaaaaaaa -->\nA later result has not been recorded.";
    const evidence = sourceEvidence("raw/synthetic.md", original, "2026-10-05");
    expect(evidence.chunks).toHaveLength(1);
    expect(original.includes(evidence.chunks[0].text)).toBe(false);
    expect(await tryLocalTransform({ ...options, batch: evidence.chunks, originals: new Map([[evidence.path, original]]) }))
      .toMatchObject({ text: null, modelId: BUILTIN_CHAT_MODEL, selectedChunks: 0, totalChunks: 1,
        failure: { status: "pending", code: "no_exact_excerpt", retryable: true } });
    expect(ipc.localTransform).not.toHaveBeenCalled();
  });

  it("checks the saved-original fingerprint before requesting generation", async () => {
    await expect(tryLocalTransform({ ...options, originals: new Map([[source.path, raw + "\nChanged source."]]) }))
      .rejects.toBeInstanceOf(LocalTransformSourceError);
    expect(ipc.localTransform).not.toHaveBeenCalled();
  });

  it.each([0, -1, 7, NaN, undefined])("does not invent a selected-chunk count for invalid native count %s", async selected_chunks => {
    vi.mocked(ipc.localTransform).mockResolvedValue({ answer, model_id: BUILTIN_CHAT_MODEL, used_sources: ["raw/synthetic.md"], selected_chunks });
    expect((await tryLocalTransform(options))?.text).toBeNull();
  });

  it.each(["source_verification_failed", "source_changed_during_generation"] as const)("rejects %s without a quote fallback", async reason => {
    vi.mocked(ipc.localTransform).mockResolvedValue({ answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: reason });
    await expect(tryLocalTransform(options)).rejects.toBeInstanceOf(LocalTransformSourceError);
  });

  it("rejects a vault transition rather than converting it into stale writes", async () => {
    vi.mocked(ipc.localTransform).mockRejectedValue(new Error("active vault changed"));
    await expect(tryLocalTransform(options)).rejects.toBeInstanceOf(LocalTransformSourceError);
  });

  it.each([
    { answer: "Unsupported citation [[wiki/other]]", model_id: BUILTIN_CHAT_MODEL, used_sources: ["wiki/other.md"] },
    { answer: "No citation", model_id: BUILTIN_CHAT_MODEL, used_sources: ["raw/synthetic.md"] },
    { answer, model_id: "other-model", used_sources: ["raw/synthetic.md"] },
    { answer, model_id: BUILTIN_CHAT_MODEL, used_sources: ["raw/synthetic.md", "wiki/other.md"] },
    { answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: "model_missing" },
  ])("retains truthful attempted-model metadata for unavailable or invalid replies", async reply => {
    vi.mocked(ipc.localTransform).mockResolvedValue(reply);
    const preview = await tryLocalTransform(options);
    expect(preview).toMatchObject({ text: null, modelId: BUILTIN_CHAT_MODEL, selectedChunks: 6, totalChunks: 12,
      failure: { status: "fallback_reason" in reply && reply.fallback_reason === "model_missing" ? "pending" : "failed",
        code: "fallback_reason" in reply && reply.fallback_reason === "model_missing" ? "model_missing" : "validation_rejected", retryable: true } });
  });

  it("stops waiting and cancels only its own native request", async () => {
    vi.mocked(ipc.localTransform).mockReturnValue(new Promise(() => { /* Held native request until cancellation. */ }));
    const controller = new AbortController();
    const pending = tryLocalTransform({ ...options, origin: syntheticOrigin,
      roleSnapshot: roleFixture("compilation"), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("stopped");
    expect(ipc.cancelLocalSynthesis).toHaveBeenCalledWith(vi.mocked(ipc.localTransform).mock.calls[0][0].requestId);
  });

  it("does not dispatch generation when stopped while capturing the native role", async () => {
    let release!: (snapshot: Awaited<ReturnType<typeof ipc.captureModelRole>>) => void;
    vi.mocked(ipc.captureModelRole).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = tryLocalTransform({ ...options, signal: controller.signal });
    await vi.waitFor(() => expect(ipc.captureModelRole).toHaveBeenCalledOnce());
    controller.abort();
    release(roleFixture("compilation"));
    await expect(pending).rejects.toThrow("stopped");
    expect(ipc.localTransform).not.toHaveBeenCalled();
    expect(ipc.cancelLocalSynthesis).not.toHaveBeenCalled();
  });

  it.each([
    roleFixture("organization"),
    roleFixture("compilation", "builtin-local", BUILTIN_CHAT_MODEL, { ...syntheticOrigin, vaultPath: "/different-vault" }),
  ])("rejects a mismatched originating preview grant before dispatch without recapture", async roleSnapshot => {
    await expect(tryLocalTransform({ ...options, origin: syntheticOrigin, roleSnapshot })).rejects.toThrow("native local transform role");
    expect(ipc.agentVaultSession).not.toHaveBeenCalled();
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(ipc.localTransform).not.toHaveBeenCalled();
  });

  it("retains IPC failure causes instead of presenting an unavailable success", async () => {
    vi.mocked(ipc.localTransform).mockRejectedValue(new Error("synthetic IPC serialization failure"));
    expect(await tryLocalTransform(options)).toMatchObject({ text: null,
      failure: { status: "failed", code: "ipc_failed", error: "Error: synthetic IPC serialization failure", retryable: true } });
  });

  it.each([
    ["model_unavailable", "pending", "unavailable"],
    ["prompt_unavailable", "pending", "unavailable"],
    ["generation_failed", "failed", "operation_failed"],
    ["answer_rejected", "failed", "validation_rejected"],
  ])("preserves native %s as %s", async (reason, status, code) => {
    vi.mocked(ipc.localTransform).mockResolvedValue({ answer: "", model_id: BUILTIN_CHAT_MODEL, used_sources: [], fallback_reason: reason });
    expect((await tryLocalTransform(options))?.failure).toMatchObject({ status, code, error: expect.stringContaining(reason), retryable: true });
  });

  it("preserves native string cancellation rather than downgrading it to an unavailable model", async () => {
    vi.mocked(ipc.localTransform).mockRejectedValue("cancelled");
    await expect(tryLocalTransform(options)).rejects.toMatchObject({ status: "stopped", code: "cancelled" });
  });
});
