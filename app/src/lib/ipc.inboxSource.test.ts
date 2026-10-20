// Serialization checks only; these synthetic DTOs do not issue native authority.
import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import {
  ipc,
  type InboxSourceSnapshot,
  type SessionCompileContext,
} from "./ipc";
import { roleFixture } from "./modelRoles.testSupport";

const origin = { vaultPath: "/synthetic", openingToken: "synthetic-opening" };
const revision = "a".repeat(64);
const snapshot: InboxSourceSnapshot = {
  snapshotId: "synthetic-snapshot",
  origin,
  inboxRel: "_inbox/original.md",
  sourceRevision: revision,
  text: "Synthetic immutable original.\n",
};
const context: SessionCompileContext = {
  jobId: "synthetic-job",
  attemptId: "synthetic-attempt",
  origin,
  source: {
    key: "synthetic-source",
    rawPath: "raw/synthetic.md",
    sourceRevision: revision,
  },
  roleSnapshot: roleFixture(
    "compilation",
    "builtin-local",
    "synthetic-model",
    origin,
    "automatic",
  ),
  compileSignature: "synthetic-signature",
  summaryPath: "wiki/source-synthetic.md",
  indexPath: "wiki/index.md",
  logPath: "wiki/log.md",
  reportPath: "ingest-reports/synthetic.md",
};
beforeEach(() => invoke.mockClear());

it("uses the native inboxRel argument and forwards the original snapshot/attempt unchanged", async () => {
  await ipc.inboxSourceSnapshot(origin, snapshot.inboxRel, revision);
  expect(invoke).toHaveBeenLastCalledWith("inbox_source_snapshot", {
    origin,
    inboxRel: snapshot.inboxRel,
    expectedRevision: revision,
  });
  await ipc.inboxCompileBegin(snapshot, "automatic");
  expect(invoke).toHaveBeenLastCalledWith("inbox_compile_begin", {
    snapshot,
    usage: "automatic",
  });
  await ipc.archiveInboxSourceChecked(snapshot, context);
  expect(invoke).toHaveBeenLastCalledWith("archive_inbox_source_checked", {
    snapshot,
    context,
  });
  await ipc.archiveInboxSourceChecked(snapshot);
  expect(invoke).toHaveBeenLastCalledWith("archive_inbox_source_checked", {
    snapshot,
    context: undefined,
  });
  await ipc.releaseInboxSource(snapshot);
  expect(invoke).toHaveBeenLastCalledWith("release_inbox_source", { snapshot });
});

it("requires a captured native opening in copy and promotion requests", async () => {
  await ipc.harvestRun(
    ["/synthetic/sessions/original.md"],
    "/synthetic",
    origin,
  );
  expect(invoke).toHaveBeenLastCalledWith("harvest_run", {
    paths: ["/synthetic/sessions/original.md"],
    vaultPath: "/synthetic",
    origin,
  });
  await ipc.promoteSessions(5, "/synthetic", origin);
  expect(invoke).toHaveBeenLastCalledWith("promote_sessions", {
    limit: 5,
    vaultPath: "/synthetic",
    origin,
  });
});
