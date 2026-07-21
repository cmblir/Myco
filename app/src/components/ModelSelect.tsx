// Provider + model dropdown pair, shared by the Settings Model tab and the
// topbar model picker. Owns the live model-list fetch (ollama/openai/openrouter)
// and the fallback-to-first-connected behaviour so callers only supply the
// current selection and an onPick handler.
//
// The model is a real SELECT, not a free-text box: a user who doesn't know the
// exact model id (the common case) just PICKS one from the provider's list.
// "Custom…" reveals a text field for power users who want a model that shipped
// after this build — so nothing is lost, but the default path needs no typing.

import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import { ipc } from "../lib/ipc";
import type { ProviderDef } from "../lib/providers";
import type { Strings } from "../lib/i18n";

const CUSTOM = "__custom__";

export default function ModelSelect({
  providers,
  provider,
  model,
  onPick,
  t,
}: {
  providers: ProviderDef[];
  provider: string;
  model: string;
  onPick: (provider: string, model: string) => void;
  t?: Strings;
}): JSX.Element {
  const def = providers.find((p) => p.id === provider) ?? providers[0];
  const [models, setModels] = useState<string[]>(def?.catalog ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Power-user free-text override: on when the picker should show a text field.
  const [customMode, setCustomMode] = useState(false);
  const selectId = useId();

  // If the currently selected provider got disconnected, fall back to the
  // first connected one (and persist it) so settings never point at a
  // provider the picker can't show.
  useEffect(() => {
    if (providers.length > 0 && !providers.some((p) => p.id === provider)) {
      const first = providers[0];
      onPick(first.id, first.catalog?.[0] ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, provider]);

  useEffect(() => {
    if (!def) return;
    setModels(def.catalog ?? []);
    setError(null);
    setCustomMode(false); // a provider switch starts on its own list
    // Try live list (ollama, openai, openrouter).
    if (
      def.id === "ollama" ||
      def.id === "openai-api" ||
      def.id === "openrouter"
    ) {
      setBusy(true);
      ipc
        .listProviderModels(def.id)
        .then((arr) => {
          if (arr.length > 0) setModels(arr);
        })
        .catch((e: unknown) => setError(String(e)))
        .finally(() => setBusy(false));
    }
  }, [def]);

  if (!def) return <div className="muted">No providers connected.</div>;

  // Custom is DERIVED, not stored-and-stuck: a model that isn't in the resolved
  // list (a hand-typed / post-release id, or a stale value mid provider-switch)
  // shows the text field automatically; the moment it matches a list entry the
  // dropdown selects it. `customMode` only records an explicit "Custom…" click.
  const known = models.includes(model);
  const showCustomInput = customMode || (model !== "" && !known);
  const selectValue = showCustomInput ? CUSTOM : model;

  return (
    <>
      <div className="row" style={{ gap: 12 }}>
        <select
          className="select"
          value={provider}
          onChange={(e) => {
            const next = providers.find((p) => p.id === e.target.value);
            if (next) onPick(next.id, next.catalog?.[0] ?? model);
          }}
          style={{ flex: 1 }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          id={selectId}
          className="select"
          value={selectValue}
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
      </div>
      {showCustomInput ? (
        <input
          className="input"
          value={model}
          onChange={(e) => onPick(provider, e.target.value)}
          placeholder={t?.model_custom_ph ?? "model id"}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{ marginTop: 8, width: "100%" }}
        />
      ) : null}
      {busy ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {t?.model_fetching ?? "fetching model list…"}
        </div>
      ) : null}
      {error ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>{error}</div>
      ) : null}
    </>
  );
}
