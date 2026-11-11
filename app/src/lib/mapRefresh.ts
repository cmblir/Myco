import { ipc, type AgentVaultSession } from "./ipc";
import type { RoleSnapshot } from "./modelRoles";
import { sha256 } from "./tidyRun";
import { WorkflowOperationError } from "./workflowOutcome";

export interface MapRefreshReview { path: string; before: string; after: string }
export type ReviewMapRefresh = (review: MapRefreshReview) => Promise<boolean>;
// A routing decision from the approved-proposal runner, not a native grant.
export type MapRefreshDecision = ReviewMapRefresh | { kind: "approved-proposal"; recheck: () => Promise<void> };

export class MapRefreshRetainedError extends WorkflowOperationError {
  constructor(readonly writtenPath: string, detail: string) {
    super("pending", "unavailable", detail);
    this.name = "MapRefreshRetainedError";
  }
}

/** Review exact native merge bytes; never create a new-map manifest for an update. */
export async function refreshExistingMap(
  origin: AgentVaultSession, role: RoleSnapshot, path: string, candidate: string,
  snapshotId: string, review: MapRefreshDecision, assertCurrent: () => void, recheck: () => Promise<void>,
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
  if (typeof review === "function" && !(await review({ path, before: current.raw, after: preview.content }))) {
    throw new WorkflowOperationError("stopped", "cancelled", "Map refresh review cancelled");
  }
  if (typeof review !== "function") await review.recheck();
  assertCurrent();
  await recheck();
  assertCurrent();
  const expectedResult = await sha256(preview.content);
  assertCurrent();
  // Source checks and hashing can yield while the proposal approval changes.
  if (typeof review !== "function") await review.recheck();
  assertCurrent();
  const result = await ipc.applyMapRefresh(origin, role, key, candidate, snapshotId, preview.currentRevision).catch(error => {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.startsWith("map refresh bytes persisted but") || detail.startsWith("compiler canonical persisted but admission incomplete")) {
      throw new MapRefreshRetainedError(path, detail);
    }
    throw new WorkflowOperationError("pending", "ipc_failed", detail);
  });
  if (result?.path !== path || result.revision !== expectedResult || typeof result.changed !== "boolean" ||
      result.changed !== (expectedResult !== preview.currentRevision)) {
    throw reject("Map refresh result is unverified; output may be retained for review");
  }
  // A verified receipt belongs to the original vault even if its view has closed.
  try { assertCurrent(); }
  catch (error) {
    throw new MapRefreshRetainedError(path,
      `Map refresh verified in the original vault, but finalization stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
  return path;
}
