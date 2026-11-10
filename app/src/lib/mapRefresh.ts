import { ipc, type AgentVaultSession } from "./ipc";
import type { RoleSnapshot } from "./modelRoles";
import { sha256 } from "./tidyRun";
import { WorkflowOperationError } from "./workflowOutcome";

export interface MapRefreshReview { path: string; before: string; after: string }
export type ReviewMapRefresh = (review: MapRefreshReview) => Promise<boolean>;

/** Review exact native merge bytes; never create a new-map manifest for an update. */
export async function refreshExistingMap(
  origin: AgentVaultSession, role: RoleSnapshot, path: string, candidate: string,
  snapshotId: string, review: ReviewMapRefresh, assertCurrent: () => void, recheck: () => Promise<void>,
): Promise<string> {
  const match = /^wiki\/maps\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(path);
  const reject = (message: string) => new WorkflowOperationError("pending", "validation_rejected", message);
  if (!match) throw reject("Existing map path is invalid");
  const key = match[1];
  assertCurrent();
  const preview = await ipc.previewMapRefresh(origin, role, key, candidate, snapshotId);
  assertCurrent();
  if (preview?.path !== path || !/^[a-f0-9]{64}$/.test(preview.currentRevision) || typeof preview.content !== "string") {
    throw reject("Native map refresh preview is invalid");
  }
  const current = await ipc.readFile(`${origin.vaultPath}/${path}`);
  assertCurrent();
  if (typeof current?.raw !== "string" || await sha256(current.raw) !== preview.currentRevision) {
    throw reject("Map changed before review; retry required");
  }
  assertCurrent();
  if (!(await review({ path, before: current.raw, after: preview.content }))) {
    throw new WorkflowOperationError("stopped", "cancelled", "Map refresh review cancelled");
  }
  assertCurrent();
  await recheck();
  assertCurrent();
  const expectedResult = await sha256(preview.content);
  assertCurrent();
  const result = await ipc.applyMapRefresh(origin, role, key, candidate, snapshotId, preview.currentRevision);
  assertCurrent();
  if (result?.path !== path || result.revision !== expectedResult || typeof result.changed !== "boolean" ||
      result.changed !== (expectedResult !== preview.currentRevision)) {
    throw reject("Map refresh result is unverified; output may be retained for review");
  }
  return path;
}
