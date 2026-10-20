/** Read-only queue observation; no attempt or model authority is acquired. */
import { ipc } from "./ipc";
import type { AgentVaultSession, SessionQueueItem } from "./ipc";
import { useVaultStore } from "../stores/vaultStore";

export const SESSION_QUEUE_LIMIT = 3;
export type SessionQueueView = Awaited<
  ReturnType<typeof ipc.listWikifyPending>
>;
interface QueueOpening {
  vaultPath: string;
  vaultToken: string;
}
export type SessionQueueRead =
  | { phase: "idle" }
  | ({ phase: "loading" } & QueueOpening)
  | ({ phase: "error"; error: string } & QueueOpening)
  | ({
      phase: "ready";
      origin: AgentVaultSession;
      view: SessionQueueView;
    } & QueueOpening);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isQueueItem(value: unknown): value is SessionQueueItem {
  if (!isRecord(value)) return false;
  return (
    ["key", "title", "rawPath", "srcSlug"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.sourceRevision === "string" &&
    /^[a-f0-9]{64}$/.test(value.sourceRevision) &&
    typeof value.compilationState === "string" &&
    [
      "pending",
      "running",
      "partial",
      "stopped",
      "failed",
      "completed",
      "superseded",
    ].includes(value.compilationState) &&
    isNullableString(value.summaryPath) &&
    isNullableString(value.compileJobId) &&
    isNullableString(value.compilationReason)
  );
}

function checkedView(value: unknown): SessionQueueView {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    typeof value.pendingTotal !== "number" ||
    !Number.isSafeInteger(value.pendingTotal) ||
    value.pendingTotal < 0 ||
    value.items.length !== Math.min(value.pendingTotal, SESSION_QUEUE_LIMIT) ||
    !Array.from(value.items).every(isQueueItem)
  ) {
    throw new Error("Queue response differs from its read-only view contract");
  }
  return { pendingTotal: value.pendingTotal, items: value.items };
}

/** Hide every old response, including errors, during opening replacement. */
export function queueReadForOpening(
  read: SessionQueueRead,
  vaultPath: string | undefined,
  vaultToken: string,
  isOpeningVault: boolean,
): SessionQueueRead {
  return !isOpeningVault &&
    vaultPath &&
    vaultToken &&
    read.phase !== "idle" &&
    read.vaultPath === vaultPath &&
    read.vaultToken === vaultToken
    ? read
    : { phase: "idle" };
}

/** Cancellation drops obsolete observations; it never invokes native Stop. */
export function readSessionCompileQueue(
  vaultPath: string,
  vaultToken: string,
  onRead: (read: SessionQueueRead) => void,
): { cancel: () => void; finished: Promise<void> } {
  let cancelled = false;
  const opening = { vaultPath, vaultToken };
  const isCurrent = (): boolean => {
    const active = useVaultStore.getState();
    return (
      !cancelled &&
      !!vaultToken &&
      !active.isOpeningVault &&
      active.currentVault?.path === vaultPath &&
      active.vaultToken === vaultToken
    );
  };
  const finished = (async () => {
    if (!isCurrent()) return;
    onRead({ phase: "loading", ...opening });
    try {
      const nativeOrigin: unknown = await ipc.agentVaultSession();
      if (!isCurrent()) return;
      if (
        !isRecord(nativeOrigin) ||
        nativeOrigin.vaultPath !== vaultPath ||
        typeof nativeOrigin.openingToken !== "string" ||
        !nativeOrigin.openingToken
      ) {
        throw new Error("Queue origin differs from the selected vault opening");
      }
      const origin = Object.freeze({
        vaultPath: nativeOrigin.vaultPath,
        openingToken: nativeOrigin.openingToken,
      });
      const response = await ipc.listWikifyPending(
        vaultPath,
        origin,
        SESSION_QUEUE_LIMIT,
      );
      if (!isCurrent()) return;
      const view = checkedView(response);
      onRead({ phase: "ready", ...opening, origin, view });
    } catch (error) {
      if (isCurrent())
        onRead({ phase: "error", ...opening, error: String(error) });
    }
  })();
  return {
    cancel: () => {
      cancelled = true;
    },
    finished,
  };
}
