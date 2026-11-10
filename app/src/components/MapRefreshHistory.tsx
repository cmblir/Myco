import { useEffect, useId, useMemo, useState } from "react";
import type { Strings } from "../lib/i18n";
import { flattenMarkdown } from "../lib/graphData";
import { readMapHistory, type MapHistoryRead } from "../lib/mapRefreshHistory";
import { useVaultStore } from "../stores/vaultStore";
import "../styles/mapRefreshHistory.css";

export function MapRefreshHistoryView({
  t,
  keys,
  selected,
  read,
  onSelect,
  onReload,
}: {
  t: Strings;
  keys: string[];
  selected: string;
  read: MapHistoryRead;
  onSelect: (key: string) => void;
  onReload: () => void;
}) {
  const id = useId();
  return (
    <section
      className="map-refresh-history"
      aria-labelledby={`${id}-title`}
      aria-busy={read.phase === "loading"}
    >
      <h2 id={`${id}-title`}>{t.map_history_title}</h2>
      <p className="muted">{t.map_history_note}</p>
      <label htmlFor={id}>{t.map_history_select}</label>
      <div className="map-refresh-history__controls">
        <select
          id={id}
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
          disabled={!keys.length}
        >
          <option value="">{t.map_history_select}</option>
          {keys.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          onClick={onReload}
          disabled={!selected || read.phase === "loading"}
        >
          {t.map_history_reload}
        </button>
      </div>
      {!keys.length && <p>{t.map_history_no_maps}</p>}
      {read.phase === "loading" && <p role="status">{t.st_loading}</p>}
      {read.phase === "error" && (
        <div role="alert">
          <p>{t.map_history_error}</p>
          <pre>{read.error}</pre>
        </div>
      )}
      {read.phase === "ready" &&
        (read.history === null ? (
          <p>{t.map_history_missing}</p>
        ) : (
          <>
            {read.history.hasChangesSinceRefresh && (
              <p role="status">{t.map_history_changed}</p>
            )}
            <div className="map-refresh-history__snapshots">
              <div>
                <h3>{t.map_history_before}</h3>
                <pre tabIndex={0} aria-label={t.map_history_before}>
                  {read.history.before}
                </pre>
              </div>
              <div>
                <h3>{t.map_history_after}</h3>
                <pre tabIndex={0} aria-label={t.map_history_after}>
                  {read.history.after}
                </pre>
              </div>
            </div>
          </>
        ))}
    </section>
  );
}

function OpenMapHistory({
  t,
  vaultPath,
  vaultToken,
  keys,
}: {
  t: Strings;
  vaultPath: string;
  vaultToken: string;
  keys: string[];
}) {
  const [selected, setSelected] = useState("");
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; read: MapHistoryRead }>({
    key: "",
    read: { phase: "idle" },
  });
  const validKey = keys.includes(selected) ? selected : "";
  useEffect(() => {
    if (!validKey) return;
    return readMapHistory(vaultPath, vaultToken, validKey, (read) =>
      setResult({ key: validKey, read }),
    ).cancel;
  }, [vaultPath, vaultToken, validKey, retry]);
  return (
    <MapRefreshHistoryView
      t={t}
      keys={keys}
      selected={validKey}
      read={
        validKey && result.key === validKey ? result.read : { phase: "idle" }
      }
      onSelect={(key) => {
        setResult({ key: "", read: { phase: "idle" } });
        setSelected(key);
      }}
      onReload={() => setRetry((value) => value + 1)}
    />
  );
}

export default function MapRefreshHistory({ t }: { t: Strings }) {
  const vault = useVaultStore((state) => state.currentVault);
  const token = useVaultStore((state) => state.vaultToken);
  const opening = useVaultStore((state) => state.isOpeningVault);
  const tree = useVaultStore((state) => state.fileTree);
  const keys = useMemo(() => {
    const prefix = `${vault?.path.replace(/\\/g, "/").replace(/\/$/, "")}/wiki/maps/`;
    return flattenMarkdown(tree)
      .map((path) => path.replace(/\\/g, "/"))
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .filter((path) => /^[a-z0-9][a-z0-9-]*\.md$/.test(path))
      .map((path) => path.slice(0, -3))
      .sort();
  }, [tree, vault?.path]);
  if (!vault || !token || opening) return null;
  // Remount synchronously on same-path reopen as well as a different vault.
  return (
    <OpenMapHistory
      key={`${vault.path}:${token}`}
      t={t}
      vaultPath={vault.path}
      vaultToken={token}
      keys={keys}
    />
  );
}
