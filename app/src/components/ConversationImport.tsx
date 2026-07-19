// Conversation-import card (Ingest page) — pick a ChatGPT export or a Claude
// Code / Codex session and drop each conversation into the vault's `_inbox/` as
// a source doc. The parsing, secret-scanning and writing all happen in Rust
// (importers::import_conversations); this card just picks the file and reports
// the outcome. From _inbox/ the normal ingest pipeline turns them into wiki
// pages — this card never calls a model.

import { useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { useVaultStore } from "../stores/vaultStore";

export default function ConversationImport({ t }: { t: Strings }): JSX.Element | null {
  const currentVault = useVaultStore((s) => s.currentVault);
  const refreshTree = useVaultStore((s) => s.refreshTree);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  if (!currentVault) return null;

  function report(outcome: {
    imported: number;
    skipped: number;
    quarantined: { title: string; secrets: string[] }[];
  }): void {
    if (
      outcome.imported === 0 &&
      outcome.skipped === 0 &&
      outcome.quarantined.length === 0
    ) {
      setResult(t.ci_none ?? "No conversations found.");
      return;
    }
    const done = (t.ci_done ?? "Imported {n} conversation(s) into _inbox/.").replace(
      "{n}",
      String(outcome.imported),
    );
    const skip =
      outcome.skipped > 0
        ? (t.ci_skipped ?? " ({n} already imported, skipped.)").replace(
            "{n}",
            String(outcome.skipped),
          )
        : "";
    setResult(done + skip);
    if (outcome.quarantined.length > 0) {
      setWarning(
        (t.ci_quarantined ??
          "{n} conversation(s) were held back for containing a possible secret; not imported.").replace(
          "{n}",
          String(outcome.quarantined.length),
        ),
      );
    }
  }

  async function sweep(kind: "claude-code" | "codex"): Promise<void> {
    setBusy(true);
    setResult(null);
    setWarning(null);
    try {
      const outcome = await ipc.importSessionSweep(kind);
      if (outcome.imported > 0) await refreshTree();
      report(outcome);
    } catch (e) {
      setResult(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickAndImport(): Promise<void> {
    const path = await ipc.pickImportFile();
    if (!path) return;
    setBusy(true);
    setResult(null);
    setWarning(null);
    try {
      const outcome = await ipc.importConversations(path);
      if (outcome.imported === 0 && outcome.quarantined.length === 0) {
        setResult(t.ci_none ?? "No conversations found in that file.");
        return;
      }
      if (outcome.imported > 0 || outcome.skipped > 0) {
        if (outcome.imported > 0) await refreshTree();
        const done = (t.ci_done ?? "Imported {n} conversation(s) into _inbox/.").replace(
          "{n}",
          String(outcome.imported),
        );
        const skip =
          outcome.skipped > 0
            ? (t.ci_skipped ?? " ({n} already imported, skipped.)").replace(
                "{n}",
                String(outcome.skipped),
              )
            : "";
        setResult(done + skip);
      }
      if (outcome.quarantined.length > 0) {
        setWarning(
          (t.ci_quarantined ??
            "{n} conversation(s) were held back for containing a possible secret; not imported.").replace(
            "{n}",
            String(outcome.quarantined.length),
          ),
        );
      }
    } catch (e) {
      setResult(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card zotero-import">
      <div className="section-title" style={{ fontSize: 14 }}>
        <Icon name="upload" size={14} /> {t.ci_title ?? "Import a conversation"}
      </div>
      <p className="muted zotero-import__hint">
        {t.ci_hint ??
          "A ChatGPT export (conversations.json) or a Claude Code / Codex session (.jsonl). Each conversation lands in _inbox/ as a source doc."}
      </p>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => void pickAndImport()}
      >
        {busy ? (t.ci_busy ?? "Importing…") : (t.ci_btn ?? "Choose a file…")}
      </button>
      <p className="muted zotero-import__hint" style={{ marginTop: 12 }}>
        {t.ci_sweep_hint ??
          "Or import every session already on this machine — from ~/.claude and ~/.codex."}
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void sweep("claude-code")}
        >
          {t.ci_sweep_cc ?? "Import my Claude Code sessions"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void sweep("codex")}
        >
          {t.ci_sweep_cx ?? "Import my Codex sessions"}
        </button>
      </div>
      {result ? <p className="zotero-import__result">{result}</p> : null}
      {warning ? (
        <p
          className="zotero-import__result"
          data-testid="import-secret-warning"
          style={{ color: "#b45309" }}
        >
          {warning}
        </p>
      ) : null}
    </section>
  );
}
