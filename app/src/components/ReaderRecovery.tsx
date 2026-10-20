import { useRef, useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import type { FileContent } from "../lib/ipc";
import { confirmAction } from "../stores/dialogStore";
import { useVaultStore } from "../stores/vaultStore";

export interface ReaderRecoverySnapshot {
  path: string;
  draft: string | undefined;
  text: string | undefined;
  originalBaseline: string | undefined;
  isCurrent: () => boolean;
  prepare: () => void;
  adopt: (file: FileContent) => boolean;
}

export interface ReaderRecoveryFeedback {
  message: string;
  error: boolean;
}

/** Explicit recovery preserves the captured draft until an admitted read lands. */
export default function ReaderRecovery({
  t, visible, readOnly, canCopy, originalBaseline, currentFile, recoveryDraft, onRetryRead, capture, onBusyChange, onFeedback,
}: {
  t: Strings;
  visible: boolean;
  readOnly: boolean;
  canCopy: boolean;
  originalBaseline?: string;
  currentFile?: string;
  recoveryDraft?: string;
  onRetryRead?: () => Promise<void>;
  capture: () => ReaderRecoverySnapshot | null;
  onBusyChange: (busy: boolean) => void;
  onFeedback: (feedback: ReaderRecoveryFeedback | null) => void;
}): JSX.Element | null {
  const [busy, setBusy] = useState<"copy" | "confirm" | "reload" | null>(null);
  const active = useRef(false);

  async function copyText(kind: "draft" | "baseline"): Promise<void> {
    if (active.current) return;
    const snapshot = capture();
    if (!snapshot) return;
    const text = kind === "baseline" ? snapshot.originalBaseline : snapshot.text;
    if (text === undefined) return;
    active.current = true;
    setBusy("copy");
    onBusyChange(true);
    onFeedback(null);
    try {
      // Invoke inside try so an absent clipboard API follows the error path too.
      await navigator.clipboard.writeText(text);
      if (snapshot.isCurrent()) onFeedback({
        message: kind === "baseline" ? t.rd_baseline_copied : t.rd_draft_copied,
        error: false,
      });
    } catch {
      if (snapshot.isCurrent()) onFeedback({
        message: kind === "baseline" ? t.rd_baseline_copy_failed : t.rd_draft_copy_failed,
        error: true,
      });
    } finally {
      active.current = false;
      setBusy(null);
      onBusyChange(false);
    }
  }

  async function retryFileRead(): Promise<void> {
    if (active.current || !onRetryRead) return;
    active.current = true;
    setBusy("reload");
    onBusyChange(true);
    onFeedback(null);
    try {
      await onRetryRead();
    } catch (error) {
      onFeedback({ message: `${t.rd_unreadable} ${String(error)}`, error: true });
    } finally {
      active.current = false;
      setBusy(null);
      onBusyChange(false);
    }
  }

  async function reloadDraft(): Promise<void> {
    if (active.current || readOnly) return;
    const snapshot = capture();
    if (!snapshot) return;
    active.current = true;
    setBusy("confirm");
    onBusyChange(true);
    onFeedback(null);
    try {
      const confirmed = await confirmAction({
        title: t.rd_reload_draft_title,
        message: t.rd_reload_draft_confirm,
        danger: true,
        confirmLabel: t.rd_reload_draft,
      });
      if (!confirmed) return;
      if (!snapshot.isCurrent()) return;
      snapshot.prepare();
      setBusy("reload");
      const file = await useVaultStore.getState().recoverEditorFile(snapshot.path, snapshot.draft, snapshot.isCurrent);
      if (snapshot.adopt(file)) onFeedback({ message: t.rd_draft_reloaded, error: false });
    } catch (error) {
      if (snapshot.isCurrent()) onFeedback({ message: `${t.rd_draft_reload_failed} ${String(error)}`, error: true });
    } finally {
      active.current = false;
      setBusy(null);
      onBusyChange(false);
    }
  }

  if (!visible) return null;
  return (
    <div className="reader-recovery" aria-busy={busy !== null}>
      {onRetryRead === undefined || recoveryDraft !== undefined ? (
        <button type="button" className="btn" disabled={busy !== null || !canCopy} onClick={() => { void copyText("draft"); }}>
          {t.rd_copy_draft}
        </button>
      ) : null}
      {originalBaseline !== undefined ? (
        <button type="button" className="btn" disabled={busy !== null || !canCopy} onClick={() => { void copyText("baseline"); }}>
          {t.rd_copy_baseline}
        </button>
      ) : null}
      {onRetryRead ? (
        <button
          type="button" className="btn" disabled={busy !== null}
          onClick={() => { void retryFileRead(); }}
        >
          {busy === "reload" ? t.rd_reloading_draft : t.rd_retry_file_read}
        </button>
      ) : !readOnly ? (
        <button
          type="button" className="btn" disabled={busy === "copy" || busy === "reload"}
          onClick={(event) => { event.currentTarget.focus(); void reloadDraft(); }}
        >
          {busy === "reload" ? t.rd_reloading_draft : t.rd_reload_draft}
        </button>
      ) : null}
      {originalBaseline !== undefined ? (
        <details className="reader-recovery-source">
          <summary>{t.rd_original_baseline}</summary>
          <pre>{originalBaseline}</pre>
        </details>
      ) : null}
      {recoveryDraft !== undefined ? (
        <details className="reader-recovery-source">
          <summary>{t.rd_recovery_draft}</summary>
          <pre>{recoveryDraft}</pre>
        </details>
      ) : null}
      {currentFile !== undefined ? (
        <details className="reader-recovery-source">
          <summary>{t.rd_current_file}</summary>
          <pre>{currentFile}</pre>
        </details>
      ) : null}
    </div>
  );
}
