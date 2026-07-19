// Provider + model dropdown pair, shared by the Settings Model tab and the
// topbar model picker. Owns the live model-list fetch (ollama/openai/openrouter)
// and the fallback-to-first-connected behaviour so callers only supply the
// current selection and an onPick handler.

import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import { ipc } from "../lib/ipc";
import type { ProviderDef } from "../lib/providers";

export default function ModelSelect({
  providers,
  provider,
  model,
  onPick,
}: {
  providers: ProviderDef[];
  provider: string;
  model: string;
  onPick: (provider: string, model: string) => void;
}): JSX.Element {
  const def = providers.find((p) => p.id === provider) ?? providers[0];
  const [models, setModels] = useState<string[]>(def?.catalog ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Unique per instance (Settings + topbar both render one) so the datalist
  // ids don't collide.
  const listId = useId();

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
        {/* An input+datalist, not a select: the catalog/live list is offered as
            suggestions, but you can type any model id — so a model that ships
            after this app build is still selectable without waiting for a
            release. */}
        <input
          className="input"
          list={listId}
          value={model}
          onChange={(e) => onPick(provider, e.target.value)}
          placeholder="model id"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{ flex: 2 }}
        />
        <datalist id={listId}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      {busy ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          fetching model list…
        </div>
      ) : null}
      {error ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>
          {error}
        </div>
      ) : null}
    </>
  );
}
