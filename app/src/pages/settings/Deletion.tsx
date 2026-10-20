import type { JSX } from "react";
import { SettingsCard } from "../../components/SettingsCard";
import type { Strings } from "../../lib/i18n";
import { confirmAction } from "../../stores/dialogStore";
import { useSettingsStore } from "../../stores/settingsStore";

/** Persisted policy shared by manual deletion and automatic cleanup. */
export function DeletionPolicyCard({ t }: { t: Strings }): JSX.Element {
  const { settings, loading, saving, error, update, load } = useSettingsStore();
  const permanent = settings?.permanent_delete === true;

  async function changePolicy(): Promise<void> {
    if (!settings || loading || saving) return;
    if (!permanent && !(await confirmAction({
      title: t.set_delete_permanent,
      message: t.set_delete_enable_msg,
      confirmLabel: t.set_delete_permanent,
      danger: true,
    }))) return;
    await update({ permanent_delete: !permanent });
  }

  return (
    <SettingsCard id="distill_deletion" hideValue>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem" }}>
        <div style={{ flex: "1 1 14rem" }}>
          <div style={{ fontWeight: 600 }}>{t.set_delete_title}</div>
          <p className="muted" style={{ fontSize: "0.8125rem", margin: "0.25rem 0 0" }}>{t.set_delete_desc}</p>
        </div>
        <button
          className="btn"
          type="button"
          role="switch"
          aria-label={t.set_delete_permanent}
          aria-checked={permanent}
          aria-busy={saving || loading}
          disabled={!settings || saving || loading}
          style={{ minHeight: "2.75rem" }}
          data-testid="permanent-delete-toggle"
          onClick={() => void changePolicy()}
        >
          {permanent ? t.set_delete_permanent : t.set_delete_trash}
        </button>
      </div>
      {error ? <p role="alert" style={{ color: "var(--danger)" }}>{error}</p> : null}
      {!settings && !loading ? <button className="btn" onClick={() => void load()}>{t.q_retry}</button> : null}
    </SettingsCard>
  );
}
