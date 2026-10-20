import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { DistillConfig } from "./distill";
import type { AgentVaultSession, SessionCompileContext } from "./ipc";
import type { RoleId, RoleUsage } from "./modelRoles";
import { roleFixture } from "./modelRoles.testSupport";
import { BUILTIN_FAST_CHAT_MODEL } from "./providers";
import { WorkflowOperationError } from "./workflowOutcome";

const getActiveModel = vi.fn();
let compilationChoice = { providerId: "anthropic-api", modelId: "synthetic-writer", effort: "(default)" };
function selectCompilation(choice: { provider: string; model: string; effort?: string }): void {
  compilationChoice = { providerId: choice.provider,
    modelId: choice.model || (choice.provider === "builtin-local" ? "extractive-ingest" : "synthetic-writer"),
    effort: choice.effort ?? "(default)" };
}

vi.mock("./chat", () => ({
  getActiveModel: (...a: unknown[]) => getActiveModel(...a),
}));

const runIngestProvider = vi.fn();
vi.mock("../stores/ingestStore", () => ({
  // Mirrors the real signature's 5th param so tests can see whether the
  // profile-interests grounding line reached the prompt, without pulling in
  // the real INGEST_PROMPT template.
  INGEST_PROMPT: (slug: string, title: string, _c?: unknown, _p?: unknown, interests = "") =>
    `prompt for ${slug} (${title})${interests ? ` | interests: ${interests}` : ""}`,
  runIngestProvider: (...a: unknown[]) => runIngestProvider(...a),
}));

const getSettings = vi.fn();
const getDistillConfig = vi.fn();
const fullTierItems = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const availableRawPath = vi.fn();
const archiveInboxSource = vi.fn();
const claudeRun = vi.fn();
const appendDistillManifest = vi.fn();
const scanTextSecrets = vi.fn();
const fileMtimes = vi.fn();
const validateIngest = vi.fn();
const wikifyCompleteSource = vi.fn();
const listWikifyPending = vi.fn();
const sessionSummaryPath = vi.fn();
const agentVaultSession = vi.fn();
const captureModelRole = vi.fn();
const sessionCompileBegin = vi.fn();
const sessionCompileStop = vi.fn();
const sessionCompileStep = vi.fn();
const cancelLocalSynthesis = vi.fn();
// Grounding lookup is best-effort in prod; tests default it to "no candidates".
const wikifyCandidates = vi.fn((..._a: unknown[]) => Promise.resolve([]));
vi.mock("./ipc", () => ({
  ipc: {
    getSettings: (...a: unknown[]) => getSettings(...a),
    getDistillConfig: (...a: unknown[]) => getDistillConfig(...a),
    fullTierItems: (...a: unknown[]) => fullTierItems(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    availableRawPath: (...a: unknown[]) => availableRawPath(...a),
    archiveInboxSource: (...a: unknown[]) => archiveInboxSource(...a),
    claudeRun: (...a: unknown[]) => claudeRun(...a),
    appendDistillManifest: (...a: unknown[]) => appendDistillManifest(...a),
    scanTextSecrets: (...a: unknown[]) => scanTextSecrets(...a),
    wikifyCandidates: (...a: unknown[]) => wikifyCandidates(...a),
    fileMtimes: (...a: unknown[]) => fileMtimes(...a),
    validateIngest: (...a: unknown[]) => validateIngest(...a),
    wikifyCompleteSource: (...a: unknown[]) => wikifyCompleteSource(...a),
    listWikifyPending: (...a: unknown[]) => listWikifyPending(...a),
    sessionSummaryPath: (...a: unknown[]) => sessionSummaryPath(...a),
    agentVaultSession: (...a: unknown[]) => agentVaultSession(...a),
    captureModelRole: (...a: unknown[]) => captureModelRole(...a),
    sessionCompileBegin: (...a: unknown[]) => sessionCompileBegin(...a),
    sessionCompileStop: (...a: unknown[]) => sessionCompileStop(...a),
    sessionCompileStep: (...a: unknown[]) => sessionCompileStep(...a),
    cancelLocalSynthesis: (...a: unknown[]) => cancelLocalSynthesis(...a),
  },
}));

import { runFullTierIngest } from "./fullTierIngest";
import { extractiveSummary } from "./extractiveIngest";
import { STRINGS } from "./i18n";

const CFG: DistillConfig = {
  enabled: true,
  count_trigger: 50,
  intensity: "standard",
  gate_preset: "normal",
  quarantine_ttl_days: 30,
  run_budget_items: 50,
  idle_minutes: 5,
  maturation_hours: 24,
  dormancy_decay: false,
  llm_digest_days: 3,
  llm_ingest_budget: 3,
  profile_injection: true,
};

const SESSION_BODY = '---\nsource: codex\nconversation_id: "synthetic"\nvia: mcp\ntitle: "Synthetic work"\n---\n\nSynthetic transcript.\n';
const SESSION_PENDING = {
  key: "codex:synthetic", rawPath: "raw/conversations/codex/synthetic.r1.md", title: "Synthetic work",
  sourceRevision: createHash("sha256").update(SESSION_BODY).digest("hex"), srcSlug: "synthetic-r1", summaryPath: null,
};

function nativeFailure(context: SessionCompileContext, requestId: string, state: string, reason: string,
  message = "Synthetic owned packet processing failed") {
  return { version: "SessionCompileFailureV1", message,
    outcome: { attemptId: context.attemptId, sourceRevision: context.source.sourceRevision,
      compileSignature: context.compileSignature, origin: context.origin,
      roleSnapshotId: context.roleSnapshot.snapshotId, requestId, state, reason },
    finalizationError: null };
}

beforeEach(() => {
  getActiveModel.mockReset();
  selectCompilation({ provider: "anthropic-api", model: "synthetic-writer" });
  runIngestProvider.mockReset();
  getSettings.mockReset();
  getDistillConfig.mockReset();
  fullTierItems.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  availableRawPath.mockReset();
  archiveInboxSource.mockReset();
  claudeRun.mockReset();
  appendDistillManifest.mockReset();
  scanTextSecrets.mockReset();
  fileMtimes.mockReset();
  validateIngest.mockReset();
  wikifyCompleteSource.mockReset();
  listWikifyPending.mockReset();
  sessionSummaryPath.mockReset();
  agentVaultSession.mockReset();
  captureModelRole.mockReset().mockImplementation(async (origin: AgentVaultSession, role: RoleId, usage: RoleUsage) => {
    expect(role).toBe("compilation");
    if (compilationChoice.providerId.endsWith("-cli")) throw new Error("capability_unavailable: optional CLI runner is not confined");
    return roleFixture(role, compilationChoice.providerId, compilationChoice.modelId, origin, usage, compilationChoice.effort);
  });
  sessionCompileBegin.mockReset();
  sessionCompileStop.mockReset();
  sessionCompileStep.mockReset();
  cancelLocalSynthesis.mockReset();
  wikifyCandidates.mockClear();
  listWikifyPending.mockResolvedValue({ pendingTotal: 0, items: [] });
  sessionSummaryPath.mockResolvedValue(null);

  getActiveModel.mockResolvedValue({ provider: "anthropic-api", model: "" });
  getDistillConfig.mockResolvedValue(CFG);
  // Q4 item 13 defaults: clean scan, warn-only PII mode.
  scanTextSecrets.mockResolvedValue({ secrets: [], pii: [] });
  getSettings.mockResolvedValue({ providers: {}, pii_quarantine_enabled: false });
  readFile.mockResolvedValue({ raw: "# A title\n\nbody", content: "body", frontmatter: null, path: "" });
  runIngestProvider.mockImplementation(async (args) => { args.onWritten?.([args.summaryPath]); return "preview"; });
  archiveInboxSource.mockResolvedValue("");
  appendDistillManifest.mockResolvedValue(null);
  fileMtimes.mockResolvedValue([]);
  validateIngest.mockResolvedValue({ errors: [], warnings: [] });
  agentVaultSession.mockResolvedValue({ vaultPath: "/v", openingToken: "synthetic-process:1" });
  sessionCompileBegin.mockImplementation(async (origin, source, usage: RoleUsage) => ({ jobId: "synthetic-job", attemptId: `synthetic-attempt-${source.sourceRevision}`,
    origin, source, compileSignature: "synthetic-compiler-signature",
    summaryPath: `wiki/source-session-${source.key.split(":")[0]}-${createHash("sha256").update(source.key).digest("hex").slice(0,16)}.md`,
    indexPath: "wiki/index.md", logPath: "wiki/log.md", reportPath: "ingest-reports/synthetic.md",
    roleSnapshot: roleFixture("compilation", "builtin-local", BUILTIN_FAST_CHAT_MODEL, origin, usage) }));
  sessionCompileStop.mockResolvedValue(undefined);
  cancelLocalSynthesis.mockResolvedValue(true);
  sessionCompileStep.mockImplementation(async (context: SessionCompileContext) => ({
    attemptId: context.attemptId, sourceRevision: context.source.sourceRevision,
    state: "partial", nextPacket: 1, eligibleWindows: 1, publication: null,
    step: { packetIndex: 0, processedWindows: 1, eligibleWindows: 1, omittedWindows: 0,
      reviewAccepted: false, nativeReviewRevision: "b".repeat(64), sourceSchemaChecked: true, allPacketsSeen: true },
  }));
  // Explicit transport doubles are orchestration tests, not native/model proof.
  wikifyCompleteSource.mockResolvedValue({ ok: false, state: "partial", reason: "semantic review unavailable" });
});

describe("runFullTierIngest", () => {
  it.each([false, true])("preserves explicitly automatic Compilation admission independently of pendingOnly=%s", async pendingOnly => {
    fullTierItems.mockResolvedValue([SESSION_PENDING.rawPath]);
    listWikifyPending.mockResolvedValue({ pendingTotal: 1, items: [SESSION_PENDING] });
    readFile.mockResolvedValue({ raw: SESSION_BODY });
    const origin = { vaultPath: "/v", openingToken: "synthetic-process:1" };
    const options = { pendingOnly, origin, usage: "automatic" as const };
    await runFullTierIngest("/v", options);
    expect(sessionCompileBegin).toHaveBeenCalledWith(origin,
      { key: SESSION_PENDING.key, rawPath: SESSION_PENDING.rawPath, sourceRevision: SESSION_PENDING.sourceRevision }, "automatic");
    const issued = await sessionCompileBegin.mock.results[0].value;
    expect(sessionCompileStep.mock.calls.every(call => call[0] === issued)).toBe(true);
    expect(sessionCompileStep).toHaveBeenCalledTimes(1);
    expect(runIngestProvider).not.toHaveBeenCalled();
  });

  it("keeps a user-started pending-only run foreground instead of inferring automatic consent", async () => {
    listWikifyPending.mockResolvedValue({ pendingTotal: 1, items: [SESSION_PENDING] });
    readFile.mockResolvedValue({ raw: SESSION_BODY });
    await runFullTierIngest("/v", { pendingOnly: true });
    expect(sessionCompileBegin).toHaveBeenCalledWith(
      { vaultPath: "/v", openingToken: "synthetic-process:1" },
      { key: SESSION_PENDING.key, rawPath: SESSION_PENDING.rawPath, sourceRevision: SESSION_PENDING.sourceRevision }, "foreground");
  });

  it("revalidates a runtime-pending foreground source and dispatches only its fresh native context", async () => {
    const origin = { vaultPath: "/v", openingToken: "synthetic-process:1" };
    listWikifyPending.mockResolvedValue({ pendingTotal: 1, items: [{
      ...SESSION_PENDING, compileJobId: "synthetic-job", compilationState: "pending",
      compilationReason: "compiler_runtime_revalidation_required",
    }] });
    readFile.mockResolvedValue({ raw: SESSION_BODY });
    const issuer = sessionCompileBegin.getMockImplementation()!;
    sessionCompileBegin.mockImplementationOnce(async (...args) => {
      const context = await issuer(...args);
      return { ...context, attemptId: "synthetic-fresh-runtime-attempt",
        roleSnapshot: { ...context.roleSnapshot, snapshotId: "d".repeat(64) } };
    });
    const started = vi.fn();

    const result = await runFullTierIngest("/v", {
      pendingOnly: true, origin, usage: "foreground", onSessionStarted: started,
    });

    expect(result).toMatchObject({ ingested: 0, sourcesPending: 1, status: "partial" });
    expect(listWikifyPending).toHaveBeenCalledWith("/v", origin, 1);
    expect(sessionCompileBegin).toHaveBeenCalledTimes(1);
    expect(sessionCompileBegin).toHaveBeenCalledWith(origin,
      { key: SESSION_PENDING.key, rawPath: SESSION_PENDING.rawPath,
        sourceRevision: SESSION_PENDING.sourceRevision }, "foreground");
    const fresh = await sessionCompileBegin.mock.results[0].value;
    expect(fresh.attemptId).toBe("synthetic-fresh-runtime-attempt");
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith(fresh);
    expect(sessionCompileStep).toHaveBeenCalledTimes(1);
    expect(sessionCompileStep.mock.calls[0][0]).toBe(fresh);
    expect(sessionCompileStep).toHaveBeenCalledWith(fresh, expect.any(String), "ko");
    expect(sessionCompileStop).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(claudeRun).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it("retains an automatic Compilation permission rejection without retrying foreground or another provider", async () => {
    fullTierItems.mockResolvedValue([SESSION_PENDING.rawPath]);
    readFile.mockResolvedValue({ raw: SESSION_BODY });
    const issuer = sessionCompileBegin.getMockImplementation()!;
    sessionCompileBegin.mockImplementation(async (...args) => {
      if (args[2] === "automatic") throw new Error("automatic_external_not_permitted");
      return issuer(...args);
    });
    const options = { usage: "automatic" as const };
    const result = await runFullTierIngest("/v", options);
    expect(result).toMatchObject({ ingested: 0, sourcesPending: 1 });
    expect(result.errors).toEqual([expect.stringContaining("automatic_external_not_permitted")]);
    expect(sessionCompileBegin).toHaveBeenCalledTimes(1);
    expect(sessionCompileBegin.mock.calls[0][2]).toBe("automatic");
    expect(sessionCompileStep).not.toHaveBeenCalled();
    expect(sessionCompileStop).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(claudeRun).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it("requests automatic Compilation authority before dispatching an ordinary source", async () => {
    fullTierItems.mockResolvedValue(["raw/ordinary.md"]);
    captureModelRole.mockRejectedValue(new Error("automatic_external_not_permitted"));
    const result = await runFullTierIngest("/v", { usage: "automatic" } as Parameters<typeof runFullTierIngest>[1] & { usage: RoleUsage });
    expect(captureModelRole).toHaveBeenCalledWith({ vaultPath: "/v", openingToken: "synthetic-process:1" }, "compilation", "automatic");
    expect(result).toMatchObject({ ingested: 0, sourcesPending: 1, status: "pending" });
    expect(result.issues).toEqual([expect.objectContaining({ item: "raw/ordinary.md", status: "pending", code: "unavailable" })]);
    expect(readFile).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(claudeRun).not.toHaveBeenCalled();
    expect(validateIngest).not.toHaveBeenCalled();
  });

  it("retains a caller's captured automatic Compilation grant without reading a newer global route", async () => {
    fullTierItems.mockResolvedValue(["raw/ordinary.md"]);
    getDistillConfig.mockResolvedValue({ ...CFG, profile_injection: false });
    getActiveModel.mockResolvedValue({ provider: "anthropic-api", model: "changed-global-route" });
    const origin = { vaultPath: "/v", openingToken: "synthetic-process:1" };
    const roleSnapshot = roleFixture("compilation", "builtin-local", BUILTIN_FAST_CHAT_MODEL, origin, "automatic");
    const options = { origin, roleSnapshot, usage: "automatic" as const };
    expect(await runFullTierIngest("/v", options)).toMatchObject({ ingested: 1 });
    expect(runIngestProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: "builtin-local", modelId: BUILTIN_FAST_CHAT_MODEL, origin, roleSnapshot, usage: "automatic",
    }));
    expect(runIngestProvider.mock.calls[0][0].roleSnapshot).toBe(roleSnapshot);
    expect(captureModelRole).not.toHaveBeenCalled();
    expect(agentVaultSession).not.toHaveBeenCalled();
    expect(getActiveModel).not.toHaveBeenCalled();
  });

  it.each(["role", "usage", "origin"] as const)("rejects a mismatched caller Compilation %s before source/provider work", async mismatch => {
    fullTierItems.mockResolvedValue(["raw/ordinary.md"]);
    const origin = { vaultPath: "/v", openingToken: "synthetic-process:1" };
    const roleSnapshot = roleFixture(mismatch === "role" ? "organization" : "compilation", "builtin-local", BUILTIN_FAST_CHAT_MODEL,
      mismatch === "origin" ? { ...origin, openingToken: "different-opening" } : origin,
      mismatch === "usage" ? "foreground" : "automatic");
    const options = { origin, roleSnapshot, usage: "automatic" as const };
    const result = await runFullTierIngest("/v", options);
    expect(result).toMatchObject({ ingested: 0, sourcesPending: 1 });
    expect(result.status).not.toBe("success");
    expect(result.errors[0]).toContain("Compilation grant");
    expect(readFile).not.toHaveBeenCalled();
    expect(captureModelRole).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(claudeRun).not.toHaveBeenCalled();
    expect(validateIngest).not.toHaveBeenCalled();
  });

  it("uses one automatic Compilation grant for all ordinary sources in the bounded batch", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md", "raw/b.md"]);
    const issued = roleFixture("compilation", "anthropic-api", "synthetic-writer", { vaultPath: "/v", openingToken: "synthetic-process:1" }, "automatic");
    captureModelRole.mockResolvedValue(issued);
    const options = { usage: "automatic" as const };
    expect(await runFullTierIngest("/v", options)).toMatchObject({ ingested: 2 });
    expect(captureModelRole).toHaveBeenCalledTimes(1);
    expect(runIngestProvider).toHaveBeenCalledTimes(2);
    expect(runIngestProvider.mock.calls.every(([args]) => args.roleSnapshot === issued && args.usage === "automatic")).toBe(true);
    for (const [args] of runIngestProvider.mock.calls) expect(args.origin).toEqual(issued.origin);
    expect(getActiveModel).not.toHaveBeenCalled();
  });

  it("stops the remaining batch after native revocation without recapturing or changing providers", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md", "raw/b.md"]);
    runIngestProvider.mockRejectedValue(new Error("snapshot_stale: automatic Compilation was revoked"));
    const result = await runFullTierIngest("/v", { usage: "automatic" });
    expect(result).toMatchObject({ ingested: 0, sourcesPending: 2, status: "stopped" });
    expect(result.issues).toEqual([expect.objectContaining({ item: "raw/a.md", status: "stopped", code: "cancelled" })]);
    expect(captureModelRole).toHaveBeenCalledTimes(1);
    expect(runIngestProvider).toHaveBeenCalledTimes(1);
    expect(getActiveModel).not.toHaveBeenCalled();
    expect(claudeRun).not.toHaveBeenCalled();
    expect(validateIngest).not.toHaveBeenCalled();
  });

  it("processes every native packet beyond legacy caps and trusts only its bound publication", async () => {
    listWikifyPending.mockResolvedValue({ pendingTotal: 1, items: [SESSION_PENDING] });
    readFile.mockResolvedValue({ raw: SESSION_BODY });
    let processed = 0;
    sessionCompileStep.mockImplementation(async (context: SessionCompileContext) => {
      processed++;
      const finished = processed === 31;
      return { attemptId: context.attemptId, sourceRevision: context.source.sourceRevision,
        state: finished ? "completed" : "running", nextPacket: 31, eligibleWindows: 31,
        step: { packetIndex: processed - 1, processedWindows: processed, eligibleWindows: 31,
          omittedWindows: 31 - processed, reviewAccepted: true, nativeReviewRevision: "b".repeat(64),
          sourceSchemaChecked: true, allPacketsSeen: finished },
        publication: finished ? { ok: true, state: "completed", attemptId: context.attemptId } : null };
    });
    const result = await runFullTierIngest("/v", { pendingOnly: true, usage: "automatic" });
    expect(result.ingested).toBe(1);
    expect(sessionCompileStep).toHaveBeenCalledTimes(31);
    expect(new Set(sessionCompileStep.mock.calls.map(call => call[1])).size).toBe(31);
    expect(sessionCompileStep.mock.calls.every(call => call[0].source.sourceRevision === SESSION_PENDING.sourceRevision)).toBe(true);
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it("keeps a rejected native review partial without publishing quote-only completion", async () => {
    listWikifyPending.mockResolvedValue({ pendingTotal: 1, items: [SESSION_PENDING] });
    readFile.mockResolvedValue({ raw: SESSION_BODY });
    sessionCompileStep.mockImplementation(async (context: SessionCompileContext) => ({
      attemptId: context.attemptId, sourceRevision: context.source.sourceRevision, state: "partial",
      nextPacket: 1, eligibleWindows: 1,
      step: { packetIndex: 0, processedWindows: 1, eligibleWindows: 1, omittedWindows: 0,
        reviewAccepted: false, nativeReviewRevision: "b".repeat(64), sourceSchemaChecked: true, allPacketsSeen: true },
      publication: null,
    }));
    const result = await runFullTierIngest("/v", { pendingOnly: true, usage: "automatic" });
    expect(result).toMatchObject({ ingested: 0, sourcesPending: 1, status: "partial" });
    expect(result.issues?.[0]).toMatchObject({ code: "validation_rejected" });
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it("rejects a different native attempt even when its publication says completed", async () => {
    listWikifyPending.mockResolvedValue({ pendingTotal: 1, items: [SESSION_PENDING] });
    readFile.mockResolvedValue({ raw: SESSION_BODY });
    sessionCompileStep.mockImplementation(async (context: SessionCompileContext) => ({
      attemptId: "different-attempt", sourceRevision: context.source.sourceRevision, state: "completed",
      step: null, nextPacket: 1, eligibleWindows: 1,
      publication: { ok: true, state: "completed", attemptId: "different-attempt" },
    }));
    const result = await runFullTierIngest("/v", { pendingOnly: true, usage: "automatic" });
    expect(result.ingested).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("native compiler receipt");
    // Invalid wire receipts do not authorize termination of an owned execution.
    expect(sessionCompileStop).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it("confirms native Stop when a started callback stops before packet dispatch", async () => {
    listWikifyPending.mockResolvedValue({pendingTotal:1,items:[SESSION_PENDING]});
    readFile.mockResolvedValue({raw:SESSION_BODY});
    const started = vi.fn((_context: SessionCompileContext) => { throw new WorkflowOperationError("stopped", "cancelled", "Synthetic start stopped"); });
    const result = await runFullTierIngest("/v", {pendingOnly:true,usage:"automatic",onSessionStarted:started});
    expect(result).toMatchObject({ingested:0,sourcesPending:1,status:"stopped"});
    expect(sessionCompileStop).toHaveBeenCalledTimes(1);
    expect(sessionCompileStop).toHaveBeenCalledWith(started.mock.calls[0][0], "stopped");
    expect(sessionCompileStep).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();
  });

  it("uses native source/origin/Compilation snapshot within the one-session budget", async () => {
    listWikifyPending.mockResolvedValue({ pendingTotal: 2, items: [SESSION_PENDING] });
    readFile.mockResolvedValue({ raw: SESSION_BODY });
    const result = await runFullTierIngest("/v", { pendingOnly: true, usage: "automatic" });
    expect(result).toMatchObject({ ingested: 0, sourcesPending: 1, status: "partial" });
    expect(listWikifyPending).toHaveBeenCalledWith("/v", { vaultPath: "/v", openingToken: "synthetic-process:1" }, 1);
    expect(fullTierItems).not.toHaveBeenCalled();
    expect(getActiveModel).not.toHaveBeenCalled();
    expect(sessionCompileBegin).toHaveBeenCalledWith(expect.objectContaining({openingToken:"synthetic-process:1"}),
      {key:SESSION_PENDING.key,rawPath:SESSION_PENDING.rawPath,sourceRevision:SESSION_PENDING.sourceRevision},"automatic");
    expect(sessionCompileStep).toHaveBeenCalledWith(expect.objectContaining({
      roleSnapshot: roleFixture("compilation", "builtin-local", BUILTIN_FAST_CHAT_MODEL, { vaultPath: "/v", openingToken: "synthetic-process:1" }, "automatic"),
      source: { key: SESSION_PENDING.key, rawPath: SESSION_PENDING.rawPath, sourceRevision: SESSION_PENDING.sourceRevision },
    }), expect.any(String), "ko");
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it.each(["key", "revision", "malformed-key", "malformed-revision", "malformed-identity"])(
    "rejects a pending %s mismatch before issuer/provider/wiki writes", async mismatch => {
      const item={...SESSION_PENDING};let body=SESSION_BODY;
      if(mismatch==="key")item.key="codex:another-synthetic-session";
      if(mismatch==="revision")body+="Synthetic unqueued revision.\n";
      if(mismatch==="malformed-key")item.key="";
      if(mismatch==="malformed-revision")item.sourceRevision="not-a-revision";
      if(mismatch==="malformed-identity"){
        body=SESSION_BODY.replace('conversation_id: "synthetic"','conversation_id: [invalid]');
        item.sourceRevision=createHash("sha256").update(body).digest("hex");
      }
      listWikifyPending.mockResolvedValue({pendingTotal:1,items:[item]});readFile.mockResolvedValue({raw:body});
      const result=await runFullTierIngest("/v",{pendingOnly:true,usage:"automatic"});
      expect(result.ingested).toBe(0);expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("pending session identity or source revision does not match");
      expect(sessionCompileBegin).not.toHaveBeenCalled();expect(runIngestProvider).not.toHaveBeenCalled();
      expect(claudeRun).not.toHaveBeenCalled();expect(writeFile).not.toHaveBeenCalled();
      expect(wikifyCompleteSource).not.toHaveBeenCalled();expect(wikifyCandidates).not.toHaveBeenCalled();
    });

  it("does not let a legacy connected CLI replace the native local Compilation role", async () => {
    getActiveModel.mockResolvedValue({provider:"anthropic-cli",model:"synthetic-external"});
    listWikifyPending.mockResolvedValue({pendingTotal:1,items:[SESSION_PENDING]});readFile.mockResolvedValue({raw:SESSION_BODY});
    await runFullTierIngest("/v",{pendingOnly:true,usage:"automatic"});
    expect(getActiveModel).not.toHaveBeenCalled();expect(claudeRun).not.toHaveBeenCalled();
    expect(sessionCompileStep).toHaveBeenCalledWith(expect.objectContaining({roleSnapshot: roleFixture("compilation", "builtin-local", BUILTIN_FAST_CHAT_MODEL, { vaultPath: "/v", openingToken: "synthetic-process:1" }, "automatic")}), expect.any(String), "ko");
    expect(runIngestProvider).not.toHaveBeenCalled();
  });

  it("keeps an explicitly selected unavailable external compiler pending without fallback", async () => {
    const issuer=sessionCompileBegin.getMockImplementation()!;
    sessionCompileBegin.mockImplementation(async (...args)=>{
      const context=await issuer(...args);context.roleSnapshot.routeSignature.providerId="myco-pro";return context;
    });
    listWikifyPending.mockResolvedValue({pendingTotal:1,items:[SESSION_PENDING]});readFile.mockResolvedValue({raw:SESSION_BODY});
    const result=await runFullTierIngest("/v",{pendingOnly:true,usage:"automatic"});
    expect(result).toMatchObject({ingested:0,sourcesPending:1,status:"pending"});
    expect(result.errors[0]).toContain("external session compiler adapter is unavailable");
    expect(runIngestProvider).not.toHaveBeenCalled();expect(claudeRun).not.toHaveBeenCalled();
    expect(sessionCompileStep).not.toHaveBeenCalled();
    expect(sessionCompileStop).toHaveBeenCalledWith(expect.any(Object),"preparation_required");
  });

  it.each([
    "local model is not installed or readable: No such file or directory (os error 2)",
    "resolve models directory: No such file or directory (os error 2)",
    "no local chat model is bundled: install and verify a local model before requesting a reply",
  ])("native confirmed missing local weights remain pending without a provider fallback: %s", async message => {
    listWikifyPending.mockResolvedValue({pendingTotal:1,items:[SESSION_PENDING]});
    readFile.mockResolvedValue({raw:SESSION_BODY});
    // Preparation status now comes from the saved native outcome, rather than
    // a generic message followed by a client-issued preparation Stop.
    sessionCompileStep.mockImplementation(async (context: SessionCompileContext, requestId: string) => {
      throw nativeFailure(context, requestId, "pending", "model_preparation_unavailable", message);
    });
    const result = await runFullTierIngest("/v", {pendingOnly:true,usage:"automatic"});
    expect(result).toMatchObject({ingested:0,sourcesPending:1,status:"pending"});
    expect(result.issues).toEqual([expect.objectContaining({status:"pending",code:"model_missing"})]);
    expect(sessionCompileStop).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(claudeRun).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "processing_failed", "operation_failed"],
    ["stopped", "cancelled", "cancelled"],
  ])("preserves native confirmed %s despite a model-preparation-like message", async (state, reason, code) => {
    listWikifyPending.mockResolvedValue({pendingTotal:1,items:[SESSION_PENDING]});
    readFile.mockResolvedValue({raw:SESSION_BODY});
    const message = "local model is not installed or readable: Synthetic original failure";
    sessionCompileStep.mockImplementation(async (context: SessionCompileContext, requestId: string) => {
      throw nativeFailure(context, requestId, state, reason, message);
    });
    const result = await runFullTierIngest("/v", {pendingOnly:true,usage:"automatic"});
    expect(result).toMatchObject({ingested:0,sourcesPending:1,status:state});
    expect(result.issues).toEqual([expect.objectContaining({status:state,code})]);
    expect(result.errors[0]).toContain(message);
    expect(sessionCompileStop).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(claudeRun).not.toHaveBeenCalled();
  });

  it.each([
    "local model is not installed or readable: No such file or directory (os error 2)",
    "Synthetic request busy", "Synthetic compiler authority refused",
  ])("does not infer a saved preparation state or Stop from generic packet error: %s", async message => {
    listWikifyPending.mockResolvedValue({pendingTotal:1,items:[SESSION_PENDING]});
    readFile.mockResolvedValue({raw:SESSION_BODY});
    sessionCompileStep.mockRejectedValue(new Error(message));
    const result = await runFullTierIngest("/v", {pendingOnly:true,usage:"automatic"});
    expect(result).toMatchObject({ingested:0,sourcesPending:1,status:"failed"});
    expect(result.issues).toEqual([expect.objectContaining({status:"failed",code:"operation_failed"})]);
    expect(result.errors[0]).toContain(message);
    expect(sessionCompileStop).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();
  });

  it("does not Stop a native attempt when the started observer throws before dispatch", async () => {
    listWikifyPending.mockResolvedValue({pendingTotal:1,items:[SESSION_PENDING]});
    readFile.mockResolvedValue({raw:SESSION_BODY});
    const result = await runFullTierIngest("/v", {pendingOnly:true,usage:"automatic",onSessionStarted:() => {
      throw new Error("Synthetic started observer failed");
    }});
    expect(result).toMatchObject({ingested:0,sourcesPending:1,status:"failed"});
    expect(result.errors[0]).toContain("Synthetic started observer failed");
    expect(sessionCompileStep).not.toHaveBeenCalled();
    expect(sessionCompileStop).not.toHaveBeenCalled();
  });

  it("ordinary Pro source ingestion and native local session compilation keep independent routes", async () => {
    selectCompilation({provider:"myco-pro",model:""});getSettings.mockResolvedValue({providers:{myco_pro:true}});
    fullTierItems.mockResolvedValue([SESSION_PENDING.rawPath,"raw/a.md"]);readFile.mockResolvedValue({raw:SESSION_BODY});
    const result=await runFullTierIngest("/v");expect(result.ingested).toBe(1);expect(result.sourcesPending).toBe(1);
    expect(runIngestProvider).toHaveBeenCalledWith(expect.objectContaining({provider:"myco-pro",source:"a"}));
    expect(sessionCompileStep).toHaveBeenCalledWith(expect.objectContaining({source: expect.objectContaining({key:SESSION_PENDING.key}),
      roleSnapshot: roleFixture("compilation", "builtin-local", BUILTIN_FAST_CHAT_MODEL, { vaultPath: "/v", openingToken: "synthetic-process:1" })}),expect.any(String),"ko");
    expect(runIngestProvider).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("mixed disconnected Pro keeps ordinary documents pending and compiles local sessions (session first: %s)", async sessionFirst => {
    selectCompilation({provider:"myco-pro",model:""});
    getSettings.mockResolvedValue({providers:{myco_pro:false}});
    getDistillConfig.mockResolvedValue({...CFG,profile_injection:false});
    fullTierItems.mockResolvedValue(sessionFirst ? [SESSION_PENDING.rawPath,"raw/a.md"] : ["raw/a.md",SESSION_PENDING.rawPath]);
    readFile.mockResolvedValue({raw:SESSION_BODY});
    sessionCompileStep.mockImplementation(async (context:SessionCompileContext)=>({
      attemptId:context.attemptId,sourceRevision:context.source.sourceRevision,state:"completed",step:null,
      nextPacket:1,eligibleWindows:1,publication:{ok:true,state:"completed",attemptId:context.attemptId},
    }));
    const result = await runFullTierIngest("/v");
    expect(result).toMatchObject({ingested:1,skipped:null,sourcesPending:1,status:"partial"});
    expect(result.issues).toEqual([expect.objectContaining({item:"raw/a.md",status:"pending",code:"unavailable"})]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("raw/a.md");
    expect(result.errors[0]).toContain("Selected provider is not connected");
    expect(sessionCompileStep).toHaveBeenCalledTimes(1);
    expect(sessionCompileStep).toHaveBeenCalledWith(expect.objectContaining({source:expect.objectContaining({
      key:SESSION_PENDING.key,sourceRevision:SESSION_PENDING.sourceRevision}),
      roleSnapshot: roleFixture("compilation", "builtin-local", BUILTIN_FAST_CHAT_MODEL, { vaultPath: "/v", openingToken: "synthetic-process:1" }),
    }),expect.any(String),"ko");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(`/v/${SESSION_PENDING.rawPath}`);
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(claudeRun).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
    expect(wikifyCandidates).not.toHaveBeenCalled();
    expect(fileMtimes).not.toHaveBeenCalled();
    expect(validateIngest).not.toHaveBeenCalled();
  });

  it("reuses the native canonical human summary path and does not trust mtime validation", async () => {
    fullTierItems.mockResolvedValue([SESSION_PENDING.rawPath]);readFile.mockResolvedValue({raw:SESSION_BODY});
    const issuer=sessionCompileBegin.getMockImplementation()!;
    sessionCompileBegin.mockImplementation(async (...args)=>({...await issuer(...args),summaryPath:"wiki/older/source-kept-session.md"}));
    await runFullTierIngest("/v");
    expect(sessionCompileStep).toHaveBeenCalledWith(expect.objectContaining({summaryPath:"wiki/older/source-kept-session.md",
      source:expect.objectContaining({key:SESSION_PENDING.key})}),expect.any(String),"ko");
    expect(runIngestProvider).not.toHaveBeenCalled();expect(wikifyCompleteSource).not.toHaveBeenCalled();
    expect(validateIngest).not.toHaveBeenCalled();expect(fileMtimes).not.toHaveBeenCalled();
  });

  it("propagates native summary catalog integrity failure before provider work", async () => {
    fullTierItems.mockResolvedValue([SESSION_PENDING.rawPath]);readFile.mockResolvedValue({raw:SESSION_BODY});
    sessionCompileBegin.mockRejectedValue(new Error("session summary scan budget exceeded"));
    const result=await runFullTierIngest("/v");expect(result.ingested).toBe(0);
    expect(result.errors[0]).toContain("scan budget exceeded");expect(runIngestProvider).not.toHaveBeenCalled();
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it("keeps one stable summary and distinct attempts/source hashes across revisions", async () => {
    const paths=[SESSION_PENDING.rawPath,SESSION_PENDING.rawPath.replace(".r1.",".r2.")];
    fullTierItems.mockResolvedValue(paths);readFile.mockImplementation(async(path:string)=>({raw:path.endsWith(".r2.md")?SESSION_BODY+"New synthetic evidence.\n":SESSION_BODY}));
    await runFullTierIngest("/v");
    expect(new Set(sessionCompileStep.mock.calls.map(([context])=>context.summaryPath)).size).toBe(1);
    expect(new Set(sessionCompileStep.mock.calls.map(([context])=>context.source.sourceRevision)).size).toBe(2);
    expect(new Set(sessionCompileStep.mock.calls.map(([context])=>context.attemptId)).size).toBe(2);
    expect(runIngestProvider).not.toHaveBeenCalled();expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it("provider session identities remain separate even when IDs are identical", async () => {
    fullTierItems.mockResolvedValue(["raw/conversations/claude/same.md","raw/conversations/chatgpt/same.md"]);
    readFile.mockImplementation(async(path:string)=>({raw:SESSION_BODY.replace("source: codex",`source: ${path.includes("/chatgpt/")?"chatgpt":"claude"}`)}));
    await runFullTierIngest("/v");
    expect(sessionCompileStep.mock.calls.map(([context])=>context.source.key)).toEqual(["claude:synthetic","chatgpt:synthetic"]);
    expect(new Set(sessionCompileStep.mock.calls.map(([context])=>context.summaryPath)).size).toBe(2);
  });

  it("malformed legacy conversation metadata remains pending instead of bypassing compiler identity", async () => {
    fullTierItems.mockResolvedValue([SESSION_PENDING.rawPath]);readFile.mockResolvedValue({raw:SESSION_BODY.replace('conversation_id: "synthetic"','conversation_id: [invalid]')});
    const result=await runFullTierIngest("/v");expect(result.ingested).toBe(0);expect(result.sourcesPending).toBe(1);
    expect(sessionCompileBegin).not.toHaveBeenCalled();expect(runIngestProvider).not.toHaveBeenCalled();
  });

  it("counts completion only when the native adapter explicitly returns completed", async () => {
    fullTierItems.mockResolvedValue([SESSION_PENDING.rawPath]);readFile.mockResolvedValue({raw:SESSION_BODY});
    // This is a consumer transport double, not a claim of semantic model proof.
    sessionCompileStep.mockImplementation(async(context:SessionCompileContext)=>({attemptId:context.attemptId,
      sourceRevision:context.source.sourceRevision,state:"completed",step:null,nextPacket:1,eligibleWindows:1,
      publication:{ok:true,state:"completed",attemptId:context.attemptId}}));
    expect((await runFullTierIngest("/v")).ingested).toBe(1);
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it("organizes pending sources locally without requiring a generation provider", async () => {
    selectCompilation({ provider: "builtin-local", model: "" });
    fullTierItems.mockResolvedValue(["raw/a.md"]);

    const result = await runFullTierIngest("/v");

    expect(result).toEqual({ ingested: 1, skipped: null, errors: [] });
    expect(runIngestProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: "builtin-local" }));
    expect(validateIngest).toHaveBeenCalledWith("/v", ["wiki/source-a.md"]);
  });

  it("keeps full nested revision path and valid exact-source citation labels", async () => {
    const rawPath="raw/conversations/codex/synthetic.r7.md";
    fullTierItems.mockResolvedValue([rawPath]);readFile.mockResolvedValue({raw:SESSION_BODY});
    const result=await runFullTierIngest("/v");
    const context=sessionCompileStep.mock.calls[0][0];
    expect(context.source.rawPath).toBe(rawPath);
    expect(context.source.sourceRevision).toBe(createHash("sha256").update(SESSION_BODY).digest("hex"));
    const summary=extractiveSummary(STRINGS.en,{slug:"synthetic-r7",source:rawPath.replace(/^raw\//,"").replace(/\.md$/,""),title:"Synthetic revision",candidates:[],vaultTags:[],
      body:"A synthetic revised decision retains its original immutable source and updates the active projection.",now:new Date("2026-10-04T00:00:00Z")});
    expect(summary.content).toMatch(/\[\^src-[\w-]+\]/);expect(summary.content).toContain(rawPath);
    expect(result.ingested).toBe(0);expect(result.sourcesPending).toBe(1);expect(result.status).toBe("partial");
    expect(writeFile).not.toHaveBeenCalled();expect(archiveInboxSource).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it("reports failed validation instead of trusting a successful provider exit", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md"]);
    validateIngest.mockResolvedValue({ errors: [{ page: "wiki/source-a.md", detail: "missing source citation" }], warnings: [] });
    const result = await runFullTierIngest("/v");
    expect(result.ingested).toBe(0);
    expect(result.errors[0]).toContain("missing source citation");
    expect(wikifyCompleteSource).not.toHaveBeenCalled();
  });

  it("reports nothing (not no-provider) on builtin-local with an empty queue", async () => {
    selectCompilation({ provider: "builtin-local", model: "" });
    fullTierItems.mockResolvedValue([]);

    expect(await runFullTierIngest("/v")).toEqual({
      ingested: 0,
      skipped: "nothing",
      errors: [],
    });
  });

  it("skips with no-provider when myco-pro is selected but not connected", async () => {
    selectCompilation({ provider: "myco-pro", model: "" });
    getSettings.mockResolvedValue({ providers: { myco_pro: false } });
    fullTierItems.mockResolvedValue(["raw/a.md"]);

    const result = await runFullTierIngest("/v");

    expect(result).toMatchObject({ ingested: 0, skipped: "no-provider", errors: [], sourcesPending: 1, status: "pending" });
    expect(result.issues?.[0]).toMatchObject({ code: "unavailable", retryable: true });
    expect(runIngestProvider).not.toHaveBeenCalled();
  });

  it("skips with nothing when there are no full-tier items", async () => {
    fullTierItems.mockResolvedValue([]);

    const result = await runFullTierIngest("/v");

    expect(result).toEqual({ ingested: 0, skipped: "nothing", errors: [] });
    expect(runIngestProvider).not.toHaveBeenCalled();
  });

  it("respects the budget: 5 items, budget 3 -> 3 runIngestProvider calls", async () => {
    fullTierItems.mockResolvedValue([
      "raw/a.md",
      "raw/b.md",
      "raw/c.md",
      "raw/d.md",
      "raw/e.md",
    ]);

    const result = await runFullTierIngest("/v");

    expect(runIngestProvider).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ingested: 3, skipped: null, errors: [] });
  });

  it("one item throwing collects an error and continues to the next", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md", "raw/b.md", "raw/c.md"]);
    runIngestProvider
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce(new Error("provider boom"))
      .mockResolvedValueOnce("ok");

    const result = await runFullTierIngest("/v");

    expect(result.ingested).toBe(2);
    expect(result.errors).toEqual(["raw/b.md: Error: provider boom"]);
    expect(runIngestProvider).toHaveBeenCalledTimes(3);
  });

  // Owner decision 2026-10-03 (B1): no run writes into raw/, and promoting
  // an _inbox/ item would. Those items are dropped before the budget slice,
  // so they cannot starve the raw/ items behind them.
  it("leaves _inbox/ items alone and spends the budget on raw/ items", async () => {
    fullTierItems.mockResolvedValue(["_inbox/a.md", "_inbox/b.md", "_inbox/c.md", "raw/x.md"]);

    const result = await runFullTierIngest("/v");

    expect(archiveInboxSource).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(runIngestProvider).toHaveBeenCalledTimes(1);
    expect(runIngestProvider).toHaveBeenCalledWith(expect.objectContaining({ slug: "x" }));
    expect(result).toEqual({ ingested: 1, skipped: null, errors: [] });
  });

  it("with only _inbox/ items, reports nothing and writes nothing", async () => {
    fullTierItems.mockResolvedValue(["_inbox/clip.md"]);

    expect(await runFullTierIngest("/v")).toEqual({
      ingested: 0,
      skipped: "nothing",
      errors: [],
    });
    expect(archiveInboxSource).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does not scan raw/ items — they are already past the entry boundary", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md"]);

    await runFullTierIngest("/v");

    expect(scanTextSecrets).not.toHaveBeenCalled();
    expect(runIngestProvider).toHaveBeenCalledTimes(1);
  });

  it("uses the file stem as the title when there is no ATX heading", async () => {
    fullTierItems.mockResolvedValue(["raw/no-heading.md"]);
    readFile.mockResolvedValue({ raw: "just a paragraph, no heading", content: "", frontmatter: null, path: "" });

    await runFullTierIngest("/v");

    expect(runIngestProvider).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "no-heading", title: "no-heading" }),
    );
  });

  it("strips a leading frontmatter block before searching for the title heading", async () => {
    fullTierItems.mockResolvedValue(["raw/frontmattered.md"]);
    readFile.mockResolvedValue({
      raw: "---\n# not a title, a YAML comment\ntitle: ignored\n---\n\n# Real Title\n\nbody",
      content: "",
      frontmatter: null,
      path: "",
    });

    await runFullTierIngest("/v");

    expect(runIngestProvider).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "frontmattered", title: "Real Title" }),
    );
  });

  it.each(["foreground", "automatic"] as const)("keeps an unconfined CLI unavailable before %s ordinary source work", async usage => {
    selectCompilation({ provider: "anthropic-cli", model: "sonnet", effort: "xhigh" });
    fullTierItems.mockResolvedValue(["raw/a.md"]);
    const result = await runFullTierIngest("/v", { usage });
    expect(result).toMatchObject({ ingested: 0, sourcesPending: 1, status: "pending" });
    expect(result.errors).toEqual([expect.stringContaining("capability_unavailable: optional CLI runner is not confined")]);
    expect(captureModelRole).toHaveBeenCalledWith({ vaultPath: "/v", openingToken: "synthetic-process:1" }, "compilation", usage);
    expect(readFile).not.toHaveBeenCalled();
    expect(claudeRun).not.toHaveBeenCalled();
    expect(runIngestProvider).not.toHaveBeenCalled();
    expect(validateIngest).not.toHaveBeenCalled();
  });

});

// Phase B, Task 6 (review-adjudicated): the interests grounding line is
// governed by the same profile_injection toggle as chat.ts's full profile
// paragraph — this is still profile content sent to the configured provider,
// so "a profile exists" alone is not enough. Fail CLOSED when the toggle
// can't be confirmed.
describe("runFullTierIngest profile interests grounding", () => {
  const PROFILE_MD = "## Role\nBackend engineer\n\n## Interests\n- rust\n- vector search\n";

  it("includes the interests line when the toggle is on and a profile exists", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md"]);
    readFile.mockResolvedValue({ raw: PROFILE_MD, content: "", frontmatter: null, path: "" });
    // getDistillConfig default (beforeEach) already resolves CFG with profile_injection: true.

    await runFullTierIngest("/v");

    const call = runIngestProvider.mock.calls[0][0];
    expect(call.prompt).toContain("interests: rust, vector search");
  });

  it("omits the interests line when the toggle is off, even with a profile present", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md"]);
    getDistillConfig.mockResolvedValue({ ...CFG, profile_injection: false });
    readFile.mockResolvedValue({ raw: PROFILE_MD, content: "", frontmatter: null, path: "" });

    await runFullTierIngest("/v");

    const call = runIngestProvider.mock.calls[0][0];
    expect(call.prompt).not.toContain("interests");
  });

  it("fails closed (omits the interests line) when the distill config can't be read", async () => {
    fullTierItems.mockResolvedValue(["raw/a.md"]);
    getDistillConfig.mockRejectedValue(new Error("io error"));
    readFile.mockResolvedValue({ raw: PROFILE_MD, content: "", frontmatter: null, path: "" });

    await runFullTierIngest("/v");

    const call = runIngestProvider.mock.calls[0][0];
    expect(call.prompt).not.toContain("interests");
  });
});
