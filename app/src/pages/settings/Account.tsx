// Settings > Account — who this machine is, and the vaults it has opened.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../../lib/icons";
import type { Strings } from "../../lib/i18n";
import { useVaultStore } from "../../stores/vaultStore";
import { ipc } from "../../lib/ipc";
import type { ProjectInfo } from "../../lib/ipc";
import { SettingsCard } from "../../components/SettingsCard";

export function SettingsAccount({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const openVault = useVaultStore((s) => s.openVault);
  // Independent Obsidian vault (MP-10). The scaffold command is idempotent, so
  // after a successful run we treat the vault as registered regardless of
  // whether .obsidian already existed (we infer readiness from the result).
  const [vaultReady, setVaultReady] = useState(false);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);

  async function registerVault(): Promise<void> {
    if (!currentVault) return;
    setVaultBusy(true);
    setVaultError(null);
    try {
      await ipc.scaffoldObsidianVault(currentVault.path);
      setVaultReady(true);
    } catch (e) {
      setVaultError(String(e));
    } finally {
      setVaultBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
        {t.s_account}
      </h2>
      <SettingsCard id="account_user" className="card row" style={{ gap: 14 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: "var(--ink)",
            color: "var(--bg)",
            display: "grid",
            placeItems: "center",
            fontSize: 22,
            fontWeight: 700,
          }}
        >
          M
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {t.s_local_user ?? "Local user"}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {currentVault?.path ?? t.s_no_vault ?? "no vault"} · myco
          </div>
        </div>
      </SettingsCard>
      <div className="field">
        <label>{t.s_vault_path ?? "Vault path"}</label>
        <div className="row">
          <input
            className="input"
            style={{ fontFamily: "var(--font-mono)", fontSize: 13, flex: 1 }}
            value={currentVault?.path ?? ""}
            readOnly
          />
          <button
            className="btn"
            onClick={async () => {
              const p = await ipc.pickDirectory();
              if (p) await openVault(p);
            }}
          >
            {t.s_change ?? "Change…"}
          </button>
        </div>
        <KnownVaults t={t} />
        <div
          className="row"
          style={{ marginTop: 10, gap: 10, alignItems: "center" }}
        >
          <button
            className="btn"
            onClick={() => void registerVault()}
            disabled={!currentVault || vaultBusy || vaultReady}
          >
            {vaultReady
              ? `✓ ${t.s_vault_registered ?? "Obsidian vault ready"}`
              : (t.s_vault_register ??
                "Make this an independent Obsidian vault")}
          </button>
          {vaultError ? (
            <span style={{ color: "#dc2626", fontSize: 12 }}>{vaultError}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Vaults myco already knows about, so switching is a click instead of
// re-navigating a folder dialog. The "change folder" control itself already
// lives in the account block above — this only adds the shortcut list, rather
// than a second way to do the same thing on the same screen.
function KnownVaults({ t }: { t: Strings }): JSX.Element | null {
  const currentVault = useVaultStore((s) => s.currentVault);
  const openVault = useVaultStore((s) => s.openVault);
  const [known, setKnown] = useState<ProjectInfo[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Best effort: a registry that cannot be read means "no shortcuts", never a
    // broken settings page.
    ipc
      .listUniverses()
      .then((rows) => {
        if (!cancelled) setKnown(rows);
      })
      .catch(() => {
        if (!cancelled) setKnown([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const others = known.filter((k) => k.root !== currentVault?.path);
  if (others.length === 0) return null;

  return (
    <div className="col" style={{ gap: 6, marginTop: 12 }}>
      <span className="muted" style={{ fontSize: 12 }}>
        {t.s_vault_known ?? "Vaults myco already knows"}
      </span>
      <div className="list">
        {others.map((k) => (
          <button
            key={k.root}
            type="button"
            className="list-row recent-row"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void openVault(k.root).finally(() => setBusy(false));
            }}
          >
            <span className="ic">
              <Icon name="folder" size={14} />
            </span>
            <span style={{ fontWeight: 500 }}>{k.title || k.slug}</span>
            <span className="meta">{k.noteCount}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// The Overview page's living background. Options are named after the graph's
// layouts on purpose — one vocabulary, two expressions — but the setting is
// deliberately NOT linked to the graph's own layout.
