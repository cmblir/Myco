import { runFullTierIngest, type FullTierOutcome } from "./fullTierIngest";
import { tryLock, unlock } from "./vaultLock";
import { useIngestStore } from "../stores/ingestStore";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import { ipc } from "./ipc";
import { create } from "zustand";
import { workflowIssue, type WorkflowStatus } from "./workflowOutcome";

// Bound compiler work to the current native opening plus three arrived wakeups. Further
// updates remain in the native queue for the existing periodic fallback.
const wakeups = new Map<string, number>();
const MAX_FOLLOWUPS = 3;
const controllers = new Map<string, AbortController>();

export interface SessionCompilerDisplay {
  vaultPath: string;
  vaultToken: string;
  attemptId: string | null;
  sourceKey: string | null;
  modelId: string | null;
  status: WorkflowStatus | "running";
  stopping: boolean;
  processedWindows: number | null;
  eligibleWindows: number | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  preparationRequired?: boolean;
}

/** Only native checkpoint replies supply counters; this is UI telemetry. */
export const useSessionCompilerDisplay = create<{ run: SessionCompilerDisplay | null }>(() => ({ run: null }));

/** Stop the displayed opening's owned request; terminal status awaits native ack. */
export function stopSessionPass(vaultPath: string, vaultToken: string): boolean {
  const controller = controllers.get(JSON.stringify([vaultPath, vaultToken]));
  if (!controller) return false;
  const run = useSessionCompilerDisplay.getState().run;
  if (run?.vaultPath === vaultPath && run.vaultToken === vaultToken) {
    useSessionCompilerDisplay.setState({ run: { ...run, stopping: true } });
  }
  controller.abort();
  return true;
}

function canContinue(vaultPath: string, vaultToken: string): boolean {
  const current = useVaultStore.getState();
  return current.currentVault?.path === vaultPath && current.vaultToken === vaultToken && !current.isOpeningVault &&
    useSettingsStore.getState().settings?.auto_ingest_enabled === true &&
    !["writing-raw", "plan-gate", "claude", "indexing"].includes(useIngestStore.getState().stage);
}

/** Organize one explicit MCP session update using the selected ingest provider. */
export async function runSessionPass(vaultPath: string): Promise<FullTierOutcome | null> {
  const vaultToken = useVaultStore.getState().vaultToken;
  if (!canContinue(vaultPath, vaultToken)) return null;
  const key = JSON.stringify([vaultPath, vaultToken]);
  if (wakeups.has(key)) {
    wakeups.set(key, Math.min(MAX_FOLLOWUPS, wakeups.get(key)! + 1));
    return null;
  }
  wakeups.set(key, 0);
  const controller = new AbortController();
  controllers.set(key, controller);
  let ownsLock = false;
  try {
    const origin = await ipc.agentVaultSession();
    if (origin.vaultPath !== vaultPath || !canContinue(vaultPath, vaultToken)) return null;
    if (!tryLock(vaultPath)) return null;
    ownsLock = true;
    const runPass = async (): Promise<FullTierOutcome> => {
      useSessionCompilerDisplay.setState({ run: { vaultPath, vaultToken, attemptId: null, sourceKey: null,
        modelId: null, status: "running", stopping: false, processedWindows: null, eligibleWindows: null,
        startedAt: Date.now(), finishedAt: null, error: null } });
      const update = (changes: Partial<SessionCompilerDisplay>): void => {
        const run = useSessionCompilerDisplay.getState().run;
        const current = useVaultStore.getState();
        if (run?.vaultPath === vaultPath && run.vaultToken === vaultToken && current.currentVault?.path === vaultPath &&
            current.vaultToken === vaultToken && !current.isOpeningVault) {
          useSessionCompilerDisplay.setState({ run: { ...run, ...changes } });
        }
      };
      try {
        const result = await runFullTierIngest(vaultPath, { pendingOnly: true, usage: "automatic", origin, signal: controller.signal,
          onSessionStarted: context => update({ attemptId: context.attemptId, sourceKey: context.source.key,
            modelId: context.roleSnapshot.routeSignature.modelId }),
          onSessionProgress: (_context, result) => update({ eligibleWindows: result.eligibleWindows,
            ...(result.step ? { processedWindows: result.step.processedWindows } : {}) }),
        });
        update({ status: result.status ?? (result.skipped ? "skipped" : result.errors.length ? "failed" :
          result.sourcesPending ? "pending" : "success"), stopping: false, finishedAt: Date.now(),
          error: result.errors.join("\n") || result.issues?.map(issue => issue.error).join("\n") || null,
          preparationRequired: result.issues?.some(issue => issue.code === "model_missing") ?? false });
        return result;
      } catch (error) {
        const issue = workflowIssue("session-compile", error);
        update({ status: issue.status, stopping: false, finishedAt: Date.now(), error: issue.error,
          preparationRequired: issue.code === "model_missing" });
        throw error;
      }
    };
    let outcome = await runPass();
    let latest = outcome;
    for (let followups = 0; ; followups++) {
      if ((latest.ingested > 0 || (latest.publishedSources ?? 0) > 0) && canContinue(vaultPath, vaultToken)) {
        await useVaultStore.getState().refreshTree();
      }
      if (controller.signal.aborted || followups >= MAX_FOLLOWUPS || latest.errors.length || latest.sourcesPending || latest.skipped !== null ||
          !wakeups.get(key) || !canContinue(vaultPath, vaultToken)) return outcome;
      // A stale UI setting must not schedule another paid model call.
      if (!(await ipc.getSettings()).auto_ingest_enabled || !canContinue(vaultPath, vaultToken)) return outcome;
      wakeups.set(key, wakeups.get(key)! - 1);
      latest = await runPass();
      const ingested = outcome.ingested + latest.ingested;
      outcome = { ...latest, ingested, skipped: ingested > 0 ? null : latest.skipped,
        errors: [...outcome.errors, ...latest.errors] };
    }
  } finally {
    wakeups.delete(key);
    controllers.delete(key);
    if (ownsLock) unlock(vaultPath);
  }
}
