import { ipc, type AgentVaultSession } from "./ipc";

/** Bind a visible archive action before dispatch; never refresh old authority. */
export async function captureArchiveOpening(
  vault: string,
  isCurrent: () => boolean,
): Promise<AgentVaultSession> {
  if (!isCurrent()) throw new Error("Archive view changed before capturing its opening");
  const origin = await ipc.agentVaultSession();
  if (!isCurrent() || origin.vaultPath !== vault || !origin.openingToken) {
    throw new Error("Archive vault opening changed; retry from the current view");
  }
  return Object.freeze({ ...origin });
}
