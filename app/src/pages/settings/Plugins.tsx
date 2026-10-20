// Settings > Plugins — the open vault's declarative plugins (lib/plugins):
// the vault's trust switch, then each plugin with what it adds and an on/off
// box, and each folder that is not a plugin with the reason. Trust and on/off
// are per device and per vault (stores/pluginStore). A plugin that runs code
// (stage 6) turns on only through its permission prompt, which lists the
// calls its manifest asks for; turning it off takes the grant back.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../../lib/i18n";
import { rendererBlock } from "../../lib/blocks";
import {
  SYSCALL_TEXT,
  fenceShadows,
  isGranted,
  manifestErrorText,
  runsCode,
  type PluginManifest,
} from "../../lib/plugins";
import { usePluginStore } from "../../stores/pluginStore";
import { useVaultStore } from "../../stores/vaultStore";
import { SettingsCard } from "../../components/SettingsCard";
import { Chip } from "../../components/ui";

const NO_IDS: readonly string[] = [];
const NO_GRANTS: Readonly<Record<string, readonly string[]>> = {};
// Plugin ids are plain names (lib/plugins ID_RE), safe in an element id.
const boxId = (id: string): string => `pl-box-${id}`;
const askId = (id: string): string => `pl-ask-${id}`;

const detail = {
  display: "block",
  marginTop: 4,
  fontSize: 12.5,
  overflowWrap: "anywhere",
} as const;
const mono = { fontFamily: "var(--font-mono)", fontSize: 12.5 } as const;
const row = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  gap: 12,
  padding: "12px 0",
  borderTop: "1px solid var(--line-soft)",
} as const;

export function SettingsPlugins({ t }: { t: Strings }): JSX.Element {
  const vault = useVaultStore((s) => s.currentVault?.path ?? null);
  const entries = usePluginStore((s) => s.entries);
  const loading = usePluginStore((s) => s.loading);
  const loadError = usePluginStore((s) => s.loadError);
  const trusted = usePluginStore((s) => !!vault && s.trusted.includes(vault));
  const off = usePluginStore((s) => (vault && s.disabled[vault]) || NO_IDS);
  const grants = usePluginStore(
    (s) => (vault && s.granted[vault]) || NO_GRANTS,
  );
  const { load, setTrusted, setEnabled, grant, revoke } =
    usePluginStore.getState();
  // The plugin whose permission prompt is open.
  const [asking, setAsking] = useState<string | null>(null);
  // A folder copied in while the app ran shows when the tab opens.
  useEffect(() => {
    void usePluginStore.getState().load(vault);
  }, [vault]);
  // The prompt takes focus as it opens, so it is read before Allow is
  // reached; closing it gives focus back to the plugin's box.
  useEffect(() => {
    if (asking) document.getElementById(askId(asking))?.focus();
  }, [asking]);
  const closeAsk = (id: string): void => {
    setAsking(null);
    document.getElementById(boxId(id))?.focus();
  };

  const isOn = (m: PluginManifest): boolean =>
    trusted && !off.includes(m.id) && isGranted(m, grants);

  const summary = (m: PluginManifest): JSX.Element => (
    <>
      {runsCode(m) ? (
        <span className="muted" style={detail}>
          {t.pl_code} · {t.pl_calls}:{" "}
          <span style={mono}>
            {m.permissions.join("  ") || t.pl_calls_none}
          </span>
          {isOn(m) ? ` · ${t.pl_revoke_hint}` : ""}
        </span>
      ) : null}
      {m.contributes.slash.length ? (
        <span className="muted" style={detail}>
          {t.pl_slash_items}:{" "}
          <span style={mono}>
            {m.contributes.slash.map((s) => `/${s.label}`).join("  ")}
          </span>
        </span>
      ) : null}
      {m.contributes.fences.length ? (
        <span className="muted" style={detail}>
          {t.pl_fences}:{" "}
          <span style={mono}>
            {fenceShadows(entries, off, m)
              .map((shadow, i) => {
                const f = m.contributes.fences[i];
                const note =
                  shadow === "builtin"
                    ? t.pl_fence_builtin
                    : shadow
                      ? t.pl_fence_taken.replace("{id}", shadow.by)
                      : rendererBlock(f.lang, f.renderer)?.id === "plugin-code"
                        ? t.pl_renderer_absent
                        : "";
                return (
                  "```" + f.lang + " → " + f.renderer + (note && ` (${note})`)
                );
              })
              .join(", ")}
          </span>
        </span>
      ) : null}
    </>
  );

  const prompt = (m: PluginManifest, vault: string): JSX.Element => (
    <div
      id={askId(m.id)}
      role="group"
      aria-labelledby={`${askId(m.id)}-title`}
      tabIndex={-1}
      className="card"
      style={{ margin: "0 0 12px", padding: 14 }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        closeAsk(m.id);
      }}
    >
      <p id={`${askId(m.id)}-title`} style={{ margin: 0, fontWeight: 600 }}>
        {t.pl_ask_title.replace("{name}", m.name)}
      </p>
      <p className="muted" style={{ margin: "6px 0 8px", fontSize: 13 }}>
        {t.pl_ask_desc}
      </p>
      {m.permissions.length ? (
        <ul style={{ margin: "0 0 12px", paddingLeft: 20, fontSize: 13 }}>
          {m.permissions.map((p) => (
            <li key={p} style={{ overflowWrap: "anywhere" }}>
              <span style={mono}>{p}</span> — {t[SYSCALL_TEXT[p]]}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: "0 0 12px", fontSize: 13 }}>{t.pl_ask_nothing}</p>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          className="btn btn-primary"
          onClick={() => {
            grant(vault, m.id, m.permissions);
            closeAsk(m.id);
          }}
        >
          {t.pl_allow}
        </button>
        <button className="btn" onClick={() => closeAsk(m.id)}>
          {t.dlg_cancel}
        </button>
      </div>
    </div>
  );

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
          {t.s_plugins}
        </h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.s_plugins_lede}
        </p>
      </div>
      {!vault ? (
        <div className="card muted" role="status">
          {t.pl_no_vault}
        </div>
      ) : (
        <>
          <SettingsCard id="plugins_trust" hideValue>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ flex: "1 1 16rem", minWidth: 0 }}>
                <span style={{ fontWeight: 600, display: "block" }}>
                  {t.pl_trust_title}
                </span>
                <span className="muted" style={detail}>
                  {trusted ? t.pl_trusted : t.pl_trust_desc}
                </span>
              </span>
              {trusted ? (
                <button
                  className="btn"
                  onClick={() => setTrusted(vault, false)}
                >
                  {t.pl_untrust_btn}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => setTrusted(vault, true)}
                >
                  {t.pl_trust_btn}
                </button>
              )}
            </div>
          </SettingsCard>

          <SettingsCard id="plugins_list">
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 12,
                marginBottom: 4,
              }}
            >
              <span style={{ flex: 1, fontWeight: 600 }}>{t.pl_installed}</span>
              {/* Never disabled: that drops a keyboard user's focus to
                  <body> mid-read. A second press is harmless — load keeps
                  only the latest read. */}
              <button
                className="btn"
                aria-busy={loading}
                onClick={() => void load(vault)}
              >
                {t.pl_reload}
              </button>
            </div>
            {loadError ? (
              <p
                role="alert"
                style={{ color: "var(--danger)", margin: "8px 0" }}
              >
                {t.pl_load_failed.replace("{error}", loadError)}
              </p>
            ) : null}
            {(loading || entries.length === 0) && !loadError ? (
              <p className="muted" role="status" style={{ margin: "8px 0" }}>
                {loading ? t.pl_loading : t.pl_empty}
              </p>
            ) : null}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {entries.map(({ dir, manifest: m, error }) =>
                m ? (
                  <li key={dir}>
                    {/* The whole row is the box's label: one large target. */}
                    <label
                      style={{
                        ...row,
                        cursor: trusted ? "pointer" : "default",
                      }}
                    >
                      <span style={{ flex: "1 1 16rem", minWidth: 0 }}>
                        <span style={{ fontWeight: 600 }}>{m.name}</span>{" "}
                        <span className="muted" style={mono}>
                          {m.id} · {m.version}
                        </span>
                        {summary(m)}
                        {!trusted ? (
                          <span className="muted" style={detail}>
                            {t.pl_off_until_trusted}
                          </span>
                        ) : null}
                      </span>
                      <input
                        id={boxId(m.id)}
                        type="checkbox"
                        style={{ width: 18, height: 18, margin: 3 }}
                        checked={isOn(m)}
                        disabled={!trusted}
                        aria-label={t.pl_enable.replace("{name}", m.name)}
                        onChange={(e) => {
                          if (!runsCode(m))
                            setEnabled(vault, m.id, e.target.checked);
                          // Code runs only once the prompt is answered.
                          else if (e.target.checked) setAsking(m.id);
                          else revoke(vault, m.id);
                        }}
                      />
                    </label>
                    {asking === m.id && trusted && !isOn(m)
                      ? prompt(m, vault)
                      : null}
                  </li>
                ) : (
                  <li key={dir} style={row}>
                    <span style={{ flex: "1 1 16rem", minWidth: 0 }}>
                      <span style={{ ...mono, fontWeight: 600 }}>{dir}</span>{" "}
                      <Chip label={t.pl_invalid} tone="warn" />
                      <span style={detail}>{t.pl_load_one_failed}</span>
                      {/* The validator's words (field paths, renderer ids)
                          are for whoever wrote the plugin: folded away. */}
                      {error ? (
                        <details className="muted" style={detail}>
                          <summary style={{ cursor: "pointer" }}>
                            {t.pl_details}
                          </summary>
                          <span style={detail}>
                            {manifestErrorText(t, error)}
                          </span>
                        </details>
                      ) : null}
                    </span>
                  </li>
                ),
              )}
            </ul>
          </SettingsCard>
        </>
      )}
    </div>
  );
}
