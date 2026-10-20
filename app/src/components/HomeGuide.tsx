// Home's guide card (UX S18): what the first-run wizard no longer asks. A new
// user met "import Claude Code sessions" and "keep a git history" before
// writing a single note; both wait here instead, for whoever just finished
// onboarding, until the card is closed. Settings keeps both for good
// (automatic session import, vault history).

import { useId, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { ipc } from "../lib/ipc";
import { dismissHomeGuide, homeGuideOffered, subscribeHomeGuide } from "../lib/onboarding";
import { useImportStore } from "../stores/importStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useVaultStore } from "../stores/vaultStore";
import { Button, IconButton } from "./ui";

export default function HomeGuide({ t }: { t: Strings }): JSX.Element | null {
  const shown = useSyncExternalStore(subscribeHomeGuide, homeGuideOffered);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const vault = useVaultStore((s) => s.currentVault);
  const historyOn = useSettingsStore((s) => Boolean(s.settings?.vault_history_enabled));
  const loadSettings = useSettingsStore((s) => s.load);
  const stage = useImportStore((s) => s.stage);
  const done = useImportStore((s) => s.done);
  const total = useImportStore((s) => s.total);
  const imported = useImportStore((s) => s.imported);
  const skipped = useImportStore((s) => s.skipped);
  const failed = useImportStore((s) => s.failed);
  const quarantined = useImportStore((s) => s.quarantined.length);
  const error = useImportStore((s) => s.error);
  const sweep = useImportStore((s) => s.sweep);
  if (!shown || !vault) return null;

  // aria-disabled, not disabled: the clicked button keeps focus while the
  // sweep runs (the store ignores a second start).
  const sweeping = stage === "sweeping" || stage === "importing-file";
  const importLine =
    stage === "sweeping"
      ? t.ob_imp_progress.replace("{done}", String(done)).replace("{total}", String(total))
      : stage === "partial"
        ? t.ci_partial.replace("{i}", String(imported)).replace("{s}", String(skipped)).replace("{f}", String(failed)) +
          (quarantined > 0 ? ` · ${t.ob_imp_quarantined.replace("{n}", String(quarantined))}` : "")
      : stage === "done"
        ? t.ob_imp_done.replace("{n}", String(imported)) +
          // Held-back items must be visible, or "imported then vanished" is
          // the read — the quarantine is a feature, not a loss.
          (quarantined > 0 ? ` · ${t.ob_imp_quarantined.replace("{n}", String(quarantined))}` : "")
        : stage === "error"
          ? (error ?? "")
          : null;

  // Never a silent git init (Q4 decision 1): this click is the opt-in.
  async function enableHistory(): Promise<void> {
    if (!vault || busy) return;
    setBusy(true);
    try {
      await ipc.initVaultHistory(vault.path);
      await loadSettings();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="home-guide" aria-labelledby={titleId}>
      <div className="home-guide__head">
        <h2 id={titleId}>{t.ob_guide_title}</h2>
        <IconButton
          aria-label={t.ui_close}
          onClick={dismissHomeGuide}
        >
          <Icon name="x" size={14} />
        </IconButton>
      </div>
      <div className="home-guide__row">
        <div>
          <strong>{t.ob_imp_title}</strong>
          <p>{t.ob_imp_body}</p>
          {importLine !== null ? (
            <p role={stage === "error" ? "alert" : "status"}>{importLine}</p>
          ) : null}
        </div>
        <div className="home-guide__actions">
          <Button onClick={() => void sweep("claude-code")} aria-disabled={sweeping}>
            {t.ob_imp_claude}
          </Button>
          <Button onClick={() => void sweep("codex")} aria-disabled={sweeping}>
            {t.ob_imp_codex}
          </Button>
        </div>
      </div>
      {historyOn ? null : (
        <div className="home-guide__row">
          <div>
            <strong>{t.ob_hist_title}</strong>
            <p>{t.ob_hist_body}</p>
          </div>
          <div className="home-guide__actions">
            <Button onClick={() => void enableHistory()} aria-disabled={busy} aria-busy={busy}>
              {t.vh_enable}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
