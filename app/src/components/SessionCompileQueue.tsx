import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import type { Lang, Strings } from "../lib/i18n";
import type { SessionQueueItem } from "../lib/ipc";
import {
  queueReadForOpening,
  readSessionCompileQueue,
  type SessionQueueRead,
} from "../lib/sessionCompileQueue";
import { useSessionCompilerDisplay } from "../lib/sessionIngest";
import { useIngestStore } from "../stores/ingestStore";
import { useImportStore } from "../stores/importStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import "../styles/sessionCompileQueue.css";

function stateLabel(
  state: SessionQueueItem["compilationState"],
  t: Strings,
): string {
  switch (state) {
    case "pending":
      return t.workflow_pending;
    case "running":
      return t.session_queue_running;
    case "partial":
      return t.workflow_partial;
    case "stopped":
      return t.workflow_stopped;
    case "failed":
      return t.workflow_failed;
    case "completed":
      return t.session_queue_completed;
    case "superseded":
      return t.session_queue_superseded;
    default:
      return t.session_queue_unknown;
  }
}

function reasonLabel(reason: string, t: Strings): string {
  if (
    reason === "native_compilation_or_review_incomplete" ||
    reason === "semantic_review_unavailable"
  )
    return t.session_queue_incomplete;
  if (reason === "model_host_failed") return t.session_queue_model_failed;
  if (reason === "processing_failed" || reason === "task_failed")
    return t.session_queue_processing_failed;
  if (
    reason === "model_preparation_unavailable" ||
    reason === "preparation_required"
  )
    return t.session_queue_preparation;
  if (reason === "compiler_runtime_revalidation_required")
    return t.session_queue_runtime_review;
  if (
    reason === "compiler_role_revalidation_required" ||
    reason.startsWith("compiler_role_revalidation_required:") ||
    reason === "compiler_contract_revalidation_required"
  )
    return t.session_queue_conditions_review;
  if (reason === "cancelled" || reason === "stopped") return t.workflow_stopped;
  return t.session_queue_reason_other;
}

/** Presentation accepts only an observation; it cannot resume or stop an attempt. */
export function SessionCompileQueueView({
  t,
  lang,
  read,
  onRefresh,
}: {
  t: Strings;
  lang: Lang;
  read: SessionQueueRead;
  onRefresh: () => void;
}): JSX.Element {
  const titleId = useId();
  const view = read.phase === "ready" ? read.view : null;
  const count = view
    ? t.session_queue_count
        .replace(
          "{total}",
          new Intl.NumberFormat(lang).format(view.pendingTotal),
        )
        .replace(
          "{shown}",
          new Intl.NumberFormat(lang).format(view.items.length),
        )
    : null;
  return (
    <section
      className="session-compile-queue"
      aria-labelledby={titleId}
      aria-busy={read.phase === "loading"}
      data-testid="session-compile-queue"
    >
      <div className="session-compile-queue__header">
        <h3 id={titleId}>{t.session_queue_title}</h3>
        <button
          className="btn"
          type="button"
          onClick={onRefresh}
          disabled={read.phase === "idle" || read.phase === "loading"}
        >
          {t.session_queue_refresh}
        </button>
      </div>
      {read.phase === "idle" && <p className="muted">{t.session_queue_idle}</p>}
      {read.phase === "loading" && <p role="status">{t.st_loading}</p>}
      {read.phase === "error" && (
        <div role="alert">
          <p>{t.session_queue_failed}</p>
          <p className="muted">{read.error}</p>
        </div>
      )}
      {view && (
        <>
          <p role="status">
            {view.pendingTotal === 0 ? t.session_queue_empty : count}
          </p>
          {view.items.length > 0 && (
            <ul className="session-compile-queue__rows">
              {view.items.map((item, index) => (
                <li
                  data-testid="session-compile-queue-row"
                  key={JSON.stringify([
                    item.compileJobId,
                    item.key,
                    item.rawPath,
                    item.sourceRevision,
                    index,
                  ])}
                >
                  <strong>{item.title}</strong>
                  <p>{stateLabel(item.compilationState, t)}</p>
                  {item.compilationReason && (
                    <>
                      <p className="muted">
                        {reasonLabel(item.compilationReason, t)}
                      </p>
                      <details className="intake-disclosure">
                        <summary>{t.session_queue_details}</summary>
                        <p>{item.compilationReason}</p>
                      </details>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export default function SessionCompileQueue({
  t,
}: {
  t: Strings;
}): JSX.Element {
  const root = useVaultStore((state) => state.currentVault?.path);
  const vaultToken = useVaultStore((state) => state.vaultToken);
  const isOpeningVault = useVaultStore((state) => state.isOpeningVault);
  const lang = useUIStore((state) => state.lang);
  const stage = useIngestStore((state) => state.stage);
  const importStage = useImportStore((state) => state.stage);
  const inboxRev = useIngestStore((state) => state.inboxRev);
  const compilerRun = useSessionCompilerDisplay((state) => state.run);
  const [read, setRead] = useState<SessionQueueRead>({ phase: "idle" });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!root || !vaultToken || isOpeningVault) return;
    const request = readSessionCompileQueue(root, vaultToken, setRead);
    return request.cancel;
    // Store changes invalidate observations; native queue replies supply every row.
  }, [
    root,
    vaultToken,
    isOpeningVault,
    refresh,
    stage,
    importStage,
    inboxRev,
    compilerRun?.attemptId,
    compilerRun?.status,
    compilerRun?.finishedAt,
  ]);
  return (
    <SessionCompileQueueView
      t={t}
      lang={lang}
      read={queueReadForOpening(read, root, vaultToken, isOpeningVault)}
      onRefresh={() => setRefresh((value) => value + 1)}
    />
  );
}
