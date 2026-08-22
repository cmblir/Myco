// Opt-in offer for vault git history (Q4 item 1, mockup M2-a). One strip on
// Overview: turn it on, or dismiss it for good (localStorage). Renders only
// while history is off and the offer was never dismissed.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { ipc, type VaultHistoryStatus } from "../lib/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import { loadDismissed, saveDismissed, shouldOfferHistory } from "../lib/vaultHistory";

export default function VaultHistoryBanner({ t }: { t: Strings }): JSX.Element | null {
  const vault = useVaultStore((s) => s.currentVault);
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);
  const [status, setStatus] = useState<VaultHistoryStatus | null>(null);
  const [dismissed, setDismissed] = useState(loadDismissed());
  const [busy, setBusy] = useState(false);
  const historyEnabled = settings?.vault_history_enabled;

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    ipc
      .vaultHistoryStatus(vault.path)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [vault, historyEnabled]);

  if (!vault || !status || !settings) return null;
  if (
    !shouldOfferHistory({
      gitPresent: status.git_present,
      enabled: settings.vault_history_enabled,
      dismissed,
    })
  ) {
    return null;
  }

  async function enable(): Promise<void> {
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
    <div className="update-banner" data-testid="vault-history-banner">
      <b style={{ fontWeight: 500 }}>{t.vh_banner_title ?? "Vault history is off"}</b>
      <span style={{ color: "var(--ink-2)" }}>
        {t.vh_banner_desc ?? "Turn it on to see agent changes word by word and undo them."}
      </span>
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center" }}>
        <button
          className="btn btn-primary"
          onClick={() => void enable()}
          disabled={busy}
          aria-busy={busy}
        >
          {t.vh_enable ?? "Turn on history"}
        </button>
        <button
          className="btn-ghost btn"
          onClick={() => {
            saveDismissed();
            setDismissed(true);
          }}
        >
          {t.vh_later ?? "Later"}
        </button>
      </span>
    </div>
  );
}
