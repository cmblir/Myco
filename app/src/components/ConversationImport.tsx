// Conversation-import card (Ingest page) — pick a ChatGPT / Claude.ai export or
// a Claude Code / Codex session, or sweep every session on the machine. Parsing,
// secret-scanning and writing happen in Rust; run state (progress, failures)
// lives in importStore so a long sweep survives navigating away. From _inbox/
// the normal ingest pipeline turns each conversation into wiki pages.

import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useImportStore } from "../stores/importStore";

export default function ConversationImport({ t }: { t: Strings }): JSX.Element | null {
  const currentVault = useVaultStore((s) => s.currentVault);
  const stage = useImportStore((s) => s.stage);
  const done = useImportStore((s) => s.done);
  const total = useImportStore((s) => s.total);
  const file = useImportStore((s) => s.file);
  const imported = useImportStore((s) => s.imported);
  const skipped = useImportStore((s) => s.skipped);
  const failedItems = useImportStore((s) => s.failedItems);
  const quarantined = useImportStore((s) => s.quarantined);
  const error = useImportStore((s) => s.error);
  const importFile = useImportStore((s) => s.importFile);
  const sweep = useImportStore((s) => s.sweep);
  const retryFailed = useImportStore((s) => s.retryFailed);

  if (!currentVault) return null;

  const busy = stage === "importing-file" || stage === "sweeping";
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  async function pickAndImport(): Promise<void> {
    const path = await ipc.pickImportFile();
    if (path) await importFile(path);
  }

  const resultLine = ((): string | null => {
    if (stage !== "done") return null;
    if (imported === 0 && skipped === 0 && failedItems.length === 0) {
      return t.ci_none ?? "No conversations found.";
    }
    const doneMsg = (t.ci_done ?? "Imported {n} conversation(s) into _inbox/.").replace(
      "{n}",
      imported.toLocaleString(),
    );
    const skip =
      skipped > 0
        ? (t.ci_skipped ?? " ({n} already imported, skipped.)").replace(
            "{n}",
            skipped.toLocaleString(),
          )
        : "";
    return doneMsg + skip;
  })();

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

      {/* A determinate bar + tally while a sweep runs (a single file finishes
          before it could show, so it stays a text state). */}
      {stage === "sweeping" ? (
        <div style={{ marginTop: 12 }} data-testid="import-progress">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={t.ci_busy ?? "Importing…"}
            style={{
              height: 4,
              borderRadius: 999,
              background: "var(--border, #e5e7eb)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: "var(--accent, #2563eb)",
                transition: "width 150ms linear",
              }}
            />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {(t.ci_sweep_progress ?? "Importing session {done} of {total}")
              .replace("{done}", done.toLocaleString())
              .replace("{total}", total.toLocaleString())}
          </div>
          <div
            className="muted"
            style={{
              fontSize: 11,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {(t.ci_sweep_tally ?? "imported {i} · skipped {s} · {f} failed")
              .replace("{i}", imported.toLocaleString())
              .replace("{s}", skipped.toLocaleString())
              .replace("{f}", String(failedItems.length))}
            {file ? ` — ${file}` : ""}
          </div>
        </div>
      ) : null}

      {resultLine ? <p className="zotero-import__result">{resultLine}</p> : null}
      {stage === "error" && error ? (
        <p className="zotero-import__result" style={{ color: "#dc2626" }}>
          {error}
        </p>
      ) : null}
      {stage === "done" && quarantined.length > 0 ? (
        <p
          className="zotero-import__result"
          data-testid="import-secret-warning"
          style={{ color: "#b45309" }}
        >
          {(t.ci_quarantined ??
            "{n} conversation(s) were held back for containing a possible secret; not imported.").replace(
            "{n}",
            String(quarantined.length),
          )}
        </p>
      ) : null}

      {/* Failed files: a collapsible list bounded in height, with a retry that
          re-reads only these (not the whole sweep). */}
      {stage === "done" && failedItems.length > 0 ? (
        <div style={{ marginTop: 10 }} data-testid="import-failures">
          <details>
            <summary style={{ cursor: "pointer", fontSize: 12.5 }}>
              {(t.ci_failed_summary ?? "{n} couldn't be imported").replace(
                "{n}",
                String(failedItems.length),
              )}
            </summary>
            <div
              style={{
                maxHeight: 180,
                overflowY: "auto",
                marginTop: 6,
                fontSize: 11.5,
              }}
            >
              {failedItems.map((f) => (
                <div key={f.path} className="muted" style={{ marginBottom: 2 }}>
                  <span style={{ wordBreak: "break-all" }}>{f.path}</span>
                  {" — "}
                  {f.error}
                </div>
              ))}
            </div>
          </details>
          <button
            type="button"
            className="btn"
            disabled={busy}
            style={{ marginTop: 8 }}
            onClick={() => void retryFailed()}
          >
            {(t.ci_retry_failed ?? "Retry failed ({n})").replace(
              "{n}",
              String(failedItems.length),
            )}
          </button>
        </div>
      ) : null}
    </section>
  );
}
