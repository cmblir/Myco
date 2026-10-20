// Provider + model dropdown pair for Settings. Fetches the live catalog while
// preserving the stored choice until the user explicitly applies a new one.
//
// The model is a real SELECT, not a free-text box: a user who doesn't know the
// exact model id (the common case) just PICKS one from the provider's list.
// "Custom…" reveals a text field for power users who want a model that shipped
// after this build — so nothing is lost, but the default path needs no typing.

import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import { ipc } from "../lib/ipc";
import { CLI_DEFAULT, PROVIDERS, providerName, type ProviderDef } from "../lib/providers";
import type { Strings } from "../lib/i18n";

const CUSTOM = "__custom__";

// Providers whose model list is fetched live instead of using the static
// catalog. codex-cli is local (its CLI caches the account's catalog on disk),
// the rest are HTTP list endpoints.
const LIVE_LIST = ["ollama", "openai-api", "openrouter", "codex-cli"];

export default function ModelSelect({
  providers,
  provider,
  model,
  onPick,
  effort,
  onPickEffort,
  t,
  disabled = false,
}: {
  providers: ProviderDef[];
  provider: string;
  model: string;
  onPick: (provider: string, model: string, effort?: string) => void;
  /** Reasoning effort for this role. Omit both this and `onPickEffort` to hide
   * the effort picker entirely (e.g. the topbar's compact model switch). */
  effort?: string;
  onPickEffort?: (effort: string) => void;
  t?: Strings;
  disabled?: boolean;
}): JSX.Element {
  // The stored provider may not be in the connected list (a CLI uninstalled,
  // a flag toggled off, a probe that hasn't finished). The full catalog still
  // knows it — resolve against that so the row keeps showing the USER'S
  // choice, marked disconnected, instead of silently jumping elsewhere.
  const def =
    providers.find((p) => p.id === provider) ??
    PROVIDERS.find((p) => p.id === provider) ??
    providers[0];
  const connected = providers.some((p) => p.id === provider);
  const [models, setModels] = useState<string[]>(def?.catalog ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Power-user free-text override: on when the picker should show a text field.
  const [customMode, setCustomMode] = useState(false);
  const [customDraft, setCustomDraft] = useState(model);
  const selectId = useId();

  // A disconnected selection is NEVER silently rewritten. An earlier version
  // auto-picked the first connected provider here and persisted it — which,
  // fired during any window where the connected list was momentarily
  // incomplete, overwrote the user's stored choice behind their back (a real
  // vault lost its codex-cli query provider to exactly that). The row now
  // shows the stored choice with a "(not connected)" marker instead; only an
  // explicit user pick writes.

  useEffect(() => {
    setCustomDraft(model);
    setCustomMode(false);
  }, [provider, model]);

  useEffect(() => {
    let isCurrent = true;
    setModels(def?.catalog ?? []);
    setError(null);
    setBusy(false);
    if (def && LIVE_LIST.includes(def.id)) {
      setBusy(true);
      ipc
        .listProviderModels(def.id)
        .then((arr) => {
          if (!isCurrent) return;
          // A live list never carries the "(default)" sentinel — keep it in
          // front when the provider's static catalog offers it.
          if (arr.length > 0)
            setModels(
              def.catalog?.[0] === CLI_DEFAULT ? [CLI_DEFAULT, ...arr] : arr,
            );
        })
        .catch((e: unknown) => { if (isCurrent) setError(String(e)); })
        .finally(() => { if (isCurrent) setBusy(false); });
    }
    return () => { isCurrent = false; };
  }, [def]);

  if (!def) return <div className="muted">No providers connected.</div>;

  // Custom is DERIVED, not stored-and-stuck: a model that isn't in the resolved
  // list (a hand-typed / post-release id, or a stale value mid provider-switch)
  // shows the text field automatically; the moment it matches a list entry the
  // dropdown selects it. `customMode` only records an explicit "Custom…" click.
  const known = models.includes(model);
  const showCustomInput = customMode || (model !== "" && !known);
  const selectValue = showCustomInput ? CUSTOM : model;
  const canApplyCustom = !disabled && customDraft.trim() !== "" && customDraft.trim() !== model;
  const applyCustom = (): void => {
    if (canApplyCustom) onPick(provider, customDraft.trim());
  };

  return (
    <>
      <div className="row model-select__row" style={{ gap: 12 }}>
        <select
          className="select"
          value={provider}
          disabled={disabled}
          onChange={(e) => {
            const next = providers.find((p) => p.id === e.target.value);
            if (!next) return;
            // Effort levels are provider-specific ("ultra" exists only for
            // codex): carrying one across a switch either shows a value the
            // new select has no option for, or gets rejected by the CLI.
            onPick(next.id, next.catalog?.[0] ?? model, CLI_DEFAULT);
          }}
          style={{ flex: 1 }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {providerName(t, p)}
            </option>
          ))}
          {!connected && def ? (
            <option value={def.id}>
              {providerName(t, def)} {t?.model_disconnected ?? "(not connected)"}
            </option>
          ) : null}
        </select>
        <select
          id={selectId}
          className="select"
          value={selectValue}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustomMode(true); // reveal the text field, keep current model
            } else {
              setCustomMode(false);
              onPick(provider, e.target.value);
            }
          }}
          style={{ flex: 2 }}
        >
          {/* Ensure the current value is always representable, even before a live
              list arrives or if the catalog is empty. */}
          {models.length === 0 && model && !customMode ? (
            <option value={model}>{model}</option>
          ) : null}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM}>{t?.model_custom ?? "Custom…"}</option>
        </select>
        {/* Effort: only for the CLIs that actually take one (see ProviderDef
            .efforts). "(default)" passes no flag at all. */}
        {def.efforts && onPickEffort ? (
          <select
            className="select"
            aria-label={t?.model_effort ?? "Reasoning effort"}
            title={t?.model_effort ?? "Reasoning effort"}
            value={effort ?? CLI_DEFAULT}
            disabled={disabled}
            onChange={(e) => onPickEffort(e.target.value)}
            style={{ flex: 1, minWidth: 110 }}
          >
            {def.efforts.map((lv) => (
              <option key={lv} value={lv}>
                {lv}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {showCustomInput ? (
        <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            value={customDraft}
            disabled={disabled}
            onChange={(e) => {
              setCustomMode(true);
              setCustomDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                applyCustom();
              }
            }}
            aria-label={t?.model_custom_ph ?? "model id"}
            placeholder={t?.model_custom_ph ?? "model id"}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{ flex: "1 1 160px", minWidth: 0 }}
          />
          <button type="button" className="btn" disabled={!canApplyCustom}
            onClick={applyCustom} style={{ minHeight: 44 }}>
            {t?.model_apply_custom ?? "Apply model"}
          </button>
        </div>
      ) : null}
      {busy ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {t?.model_fetching ?? "fetching model list…"}
        </div>
      ) : null}
      {error ? (
        <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>{error}</div>
      ) : null}
    </>
  );
}
