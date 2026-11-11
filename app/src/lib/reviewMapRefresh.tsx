import DiffView from "../components/DiffView";
import { confirmAction, useDialogStore } from "../stores/dialogStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { STRINGS } from "./i18n";
import type { MapRefreshReview } from "./mapRefresh";
import { diffLines, type DiffLine } from "./wordDiff";
import { WorkflowOperationError } from "./workflowOutcome";

export async function reviewMapRefresh(review: MapRefreshReview, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) return false;
  if (useDialogStore.getState().request) throw new WorkflowOperationError("pending", "unavailable", "Another review is open; retry map refresh afterward");
  const t = STRINGS[useUIStore.getState().lang];
  // The shared word diff uses quadratic LCS. Keep long model output reviewable
  // as full before/after blocks without feeding unbounded lines into that pass.
  const lines = `${review.before}\n${review.after}`.split("\n");
  const diff: DiffLine[] = lines.length <= 1000 && lines.every(line => line.length <= 2000)
    ? diffLines(review.before, review.after)
    : [{ kind: "del", segs: [{ kind: "del", text: review.before }] },
      { kind: "add", segs: [{ kind: "add", text: review.after }] }];
  const decision = confirmAction({ title: t.map_refresh_title, message: t.map_refresh_message,
    confirmLabel: t.map_refresh_apply,
    body: <><p>{review.path}</p><DiffView lines={diff} /></> });
  const request = useDialogStore.getState().request;
  const unsubscribeDialog = useDialogStore.subscribe(({ request: next }) => {
    if (next !== request) request?.resolve(null);
  });
  const unsubscribe = useVaultStore.subscribe(() => {
    if (!isCurrent() && useDialogStore.getState().request === request) useDialogStore.getState().close(null);
  });
  try { return await decision && isCurrent(); }
  finally { unsubscribe(); unsubscribeDialog(); }
}
