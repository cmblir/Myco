import { ipc, type AgentVaultSession, type ArchivePublication, type DistillPublicationReceipt, type ManagedDistillArtifact } from "./ipc";
import type { RoleSnapshot } from "./modelRoles";
import { sha256 } from "./tidyRun";
import { WorkflowOperationError } from "./workflowOutcome";

/** Reject incomplete identities before any producer dispatches native work. */
export function requirePublicationOrigin(origin: AgentVaultSession, vaultPath: string): void {
  if (!origin?.vaultPath || !origin.openingToken) {
    throw new WorkflowOperationError("pending", "validation_rejected", "Native publication requires a vault opening identity; manual recovery required");
  }
  if (origin.vaultPath !== vaultPath) throw new WorkflowOperationError("stopped", "cancelled", "Vault changed before native publication");
}

export function publicationClaim(receipt: DistillPublicationReceipt): ArchivePublication {
  return { path: receipt.path, revision: receipt.revision, created: receipt.nativeCreated };
}

/** Native still verifies the private capability and exact file identity at use. */
export async function publishManagedNote(origin: AgentVaultSession, operationId: string,
  artifact: ManagedDistillArtifact, content: string, expected: string | null, roleSnapshot?: RoleSnapshot): Promise<DistillPublicationReceipt> {
  requirePublicationOrigin(origin, origin?.vaultPath ?? "");
  if (!roleSnapshot || roleSnapshot.role !== "organization" || roleSnapshot.origin.openingToken !== origin.openingToken) throw new WorkflowOperationError("pending", "validation_rejected", "Managed publication requires its original organization role snapshot");
  let receipt: DistillPublicationReceipt;
  try { receipt = await ipc.publishDistillNote(origin, operationId, artifact, content, expected, roleSnapshot); }
  catch (error) {
    const message = String(error);
    if (/active vault changed|vault opening was superseded|no vault is open/i.test(message)) {
      throw new WorkflowOperationError("stopped", "cancelled", message);
    }
    if (/manual recovery|publication identity is not yet supported/i.test(message)) {
      throw new WorkflowOperationError("pending", "unavailable", message);
    }
    throw error;
  }
  const path = artifact.kind === "map" ? `wiki/maps/${artifact.key}.md` : `${artifact.kind}/${artifact.key}.md`;
  if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.publicationId) || receipt.state !== "published" ||
    receipt.operationId !== operationId || receipt.path !== path || receipt.revision !== await sha256(content) ||
    typeof receipt.nativeCreated !== "boolean" || !receipt.fileIdentity) {
    throw new WorkflowOperationError("pending", "validation_rejected", "Publication receipt does not match the written note; preserve artifacts for manual recovery");
  }
  return receipt;
}

export function requireNativeCreation(receipt: DistillPublicationReceipt | undefined): asserts receipt is DistillPublicationReceipt {
  if (!receipt?.nativeCreated || receipt.state !== "published" || !receipt.publicationId) {
    throw new WorkflowOperationError("pending", "unavailable", "Native creation authority is unavailable for this existing note; preserve sources and output for manual recovery");
  }
}
