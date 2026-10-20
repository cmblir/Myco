import type { AgentVaultSession } from "./ipc";
import type { RoleSnapshot } from "./modelRoles";

/** Admission/revocation failures cannot become successful quoted answers. */
export class QueryAuthorizationError extends Error {
  constructor() {
    super("Ask execution authority is missing, mismatched or stale");
    this.name = "QueryAuthorizationError";
  }
}

/** Check DTO consistency only; the native grant registry proves authority. */
export function checkedAskRole(
  origin: AgentVaultSession | undefined,
  snapshot: RoleSnapshot | undefined,
  expectedVault: string,
  modelId?: string,
): RoleSnapshot {
  const route = snapshot?.routeSignature;
  if (!origin || origin.vaultPath !== expectedVault || typeof origin.openingToken !== "string" || !origin.openingToken ||
      origin.openingToken.length > 256 || [...origin.openingToken].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      !snapshot || snapshot.role !== "ask" || snapshot.usage !== "foreground" ||
      snapshot.origin?.vaultPath !== origin.vaultPath || snapshot.origin.openingToken !== origin.openingToken ||
      !snapshot.snapshotId || !snapshot.authorizationRevision || !route || route.role !== "ask" ||
      !route.signature || !route.providerId || !route.modelId ||
      (modelId !== undefined && route.modelId !== modelId) ||
      (route.providerId === "builtin-local" ? route.executionLocation !== "in-process" :
        !["loopback", "remote"].includes(route.executionLocation))) {
    throw new QueryAuthorizationError();
  }
  return snapshot;
}

/** Native errors use static prefixes; never expose arbitrary native detail. */
export function isQueryAuthorizationError(error: unknown): boolean {
  if (error instanceof QueryAuthorizationError) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(?:snapshot_stale|role_mismatch|usage_mismatch|origin_mismatch|request_route_mismatch|route_unconfirmed|automatic_external_not_permitted|connection_unavailable|native (?:Ask|role|feature)|active vault changed)/i.test(message);
}
