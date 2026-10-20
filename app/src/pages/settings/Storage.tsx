// Settings > Account > Storage (UX S27): where the vault lives, which notes
// the last graph build could not read, whether vault history is on, and when
// a note last saved. No "synced" claim — myco has no sync of its own.

import type { JSX } from "react";
import type { Strings } from "../../lib/i18n";
import { storageProvider } from "../../lib/storageStatus";
import { vaultRel } from "../../lib/vaultAreas";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUIStore } from "../../stores/uiStore";
import { useVaultStore } from "../../stores/vaultStore";
import { SettingsCard } from "../../components/SettingsCard";
import "../../styles/settings-storage.css";

export function SettingsStorage({ t }: { t: Strings }): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const vault = useVaultStore((s) => s.currentVault);
  // null until the first build answers; `unread` absent = an older backend.
  const adjacency = useVaultStore((s) => s.adjacency);
  const unread = adjacency ? (adjacency.unread ?? []) : null;
  const lastSavedAt = useVaultStore((s) => s.lastSavedAt);
  const history = useSettingsStore((s) => s.settings?.vault_history_enabled);

  const provider = vault ? storageProvider(vault.path) : null;
  const providerLabel =
    provider === "icloud" ? t.s_storage_icloud : provider === "dropbox" ? t.s_storage_dropbox : null;

  return (
    <SettingsCard id="account_storage" className="card col storage-status">
      <h3 className="storage-status__title">{t.s_storage_title}</h3>
      <p className="muted storage-status__desc">{t.s_storage_desc}</p>
      {!vault ? (
        <p className="muted storage-status__desc">{t.s_no_vault}</p>
      ) : (
        <dl className="storage-status__rows">
          <div className="storage-status__row">
            <dt>{t.s_storage_where}</dt>
            <dd>
              {providerLabel ? <>{providerLabel} · </> : null}
              <span className="storage-status__path">{vault.path}</span>
            </dd>
          </div>
          <div className="storage-status__row">
            <dt>{t.s_storage_unread}</dt>
            <dd>
              {unread === null ? (
                <span className="muted">{t.s_storage_checking}</span>
              ) : unread.length === 0 ? (
                t.s_storage_unread_none
              ) : (
                <details>
                  <summary>
                    {t.s_storage_unread_n.replace("{n}", new Intl.NumberFormat(lang).format(unread.length))}
                  </summary>
                  <p className="muted storage-status__desc">{t.s_storage_unread_hint}</p>
                  <ul className="storage-status__list">
                    {unread.map((p) => (
                      <li key={p}>{vaultRel(p, vault.path)}</li>
                    ))}
                  </ul>
                </details>
              )}
            </dd>
          </div>
          <div className="storage-status__row">
            <dt>{t.s_storage_history}</dt>
            <dd>
              {history === undefined ? (
                <span className="muted">{t.s_storage_checking}</span>
              ) : history ? (
                t.s_val_on
              ) : (
                t.s_val_off
              )}
            </dd>
          </div>
          <div className="storage-status__row">
            <dt>{t.s_storage_last_save}</dt>
            <dd>
              {lastSavedAt === null ? (
                <span className="muted">{t.s_storage_no_save}</span>
              ) : (
                <time dateTime={new Date(lastSavedAt).toISOString()}>
                  {new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(lastSavedAt)}
                </time>
              )}
            </dd>
          </div>
        </dl>
      )}
    </SettingsCard>
  );
}
