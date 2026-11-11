import type { AgentVaultSession, DistillPublicationReceipt } from "./ipc";

export interface PendingMapPublication {
  manifestId: string;
  publication: DistillPublicationReceipt;
}

// Process-local retry hints only. Native authority is checked on every use.
const pending = new Map<string, PendingMapPublication & { origin: AgentVaultSession }>();
const key = (origin: AgentVaultSession, cluster: string) =>
  JSON.stringify([origin.vaultPath, origin.openingToken, cluster]);

export function pendingMapPublication(origin: AgentVaultSession, cluster: string): PendingMapPublication | undefined {
  return pending.get(key(origin, cluster));
}

export function rememberMapPublication(origin: AgentVaultSession, cluster: string, publication: PendingMapPublication): void {
  pending.set(key(origin, cluster), { ...publication, origin: { ...origin } });
}

/** Forget only the run that native undo confirmed, even if another opening is now active. */
export function forgetUndoneMapPublications(origin: AgentVaultSession, manifestId: string): void {
  for (const [entryKey, entry] of pending) {
    if (entry.manifestId === manifestId && entry.origin.vaultPath === origin.vaultPath &&
        entry.origin.openingToken === origin.openingToken) pending.delete(entryKey);
  }
}
