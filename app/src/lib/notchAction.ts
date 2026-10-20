/** Cross-window acknowledgement: event delivery is not successful execution. */
export const TRAY_ACTION_RESULT_EVENT = "myco://tray-action-result";
export interface VaultActionScope { vaultPath: string; vaultToken: string }
export interface TrayActionEnvelope { action: string; requestId?: string; scope?: VaultActionScope }
export interface TrayActionRequest extends TrayActionEnvelope { requestId: string }
export interface TrayActionResult { requestId: string; ok: boolean }

export function isVaultActionScope(value: unknown): value is VaultActionScope {
  return typeof value === "object" && value !== null &&
    "vaultPath" in value && typeof value.vaultPath === "string" && value.vaultPath.length > 0 &&
    "vaultToken" in value && typeof value.vaultToken === "string" && value.vaultToken.length > 0;
}

/** Native menu messages do not wait for an acknowledgement. */
export function isTrayActionEnvelope(value: unknown): value is TrayActionEnvelope {
  return typeof value === "object" && value !== null &&
    "action" in value && typeof value.action === "string" && value.action.length > 0 &&
    (!("requestId" in value) || (typeof value.requestId === "string" && value.requestId.length > 0)) &&
    (!("scope" in value) || isVaultActionScope(value.scope));
}

/** Ignore malformed cross-window messages without invoking the writer. */
export function isTrayActionRequest(value: unknown): value is TrayActionRequest {
  return isTrayActionEnvelope(value) && typeof value.requestId === "string";
}

/** Distinguish writes from legacy menu navigation at the shared broker. */
export function isVaultTrayAction(action: string): boolean {
  return action === "distill" || action === "harvest-run" ||
    action === "links-accept-all" || action === "links-dismiss-all" ||
    /^(proposal-(approve|reject)|links-(accept|dismiss)):.+$/.test(action);
}

export function vaultActionScopeKey(scope: VaultActionScope | null | undefined): string {
  return scope ? JSON.stringify([scope.vaultPath, scope.vaultToken]) : "";
}

interface AgendaActionIO {
  listen: (receive: (result: TrayActionResult) => void) => Promise<() => void>;
  emit: (request: TrayActionRequest) => Promise<void>;
}

/** Wait for the main writer's result; failed or lost requests remain retryable. */
export async function requestAgendaAction(
  action: string,
  io: AgendaActionIO,
  timeoutMs = 120_000,
  scope?: VaultActionScope,
): Promise<boolean> {
  const requestId = crypto.randomUUID();
  let finish!: (ok: boolean) => void;
  const result = new Promise<boolean>((resolve) => { finish = resolve; });
  const unlisten = await io.listen((reply) => {
    if (reply?.requestId === requestId) finish(reply.ok === true);
  });
  const timeout = setTimeout(() => finish(false), timeoutMs);
  try {
    await io.emit({ action, requestId, ...(scope ? { scope } : {}) });
    return await result;
  } finally {
    clearTimeout(timeout);
    unlisten();
  }
}
