import { useEffect, useState } from "react";
import type { Strings } from "../lib/i18n";
import {
  readMapRecovery,
  type RecoveryRead,
} from "../lib/mapRecoverySnapshots";

export function RecoverySnapshotList({
  t,
  read,
}: {
  t: Strings;
  read: RecoveryRead;
}) {
  if (read.phase === "idle" || read.phase === "loading")
    return <p role="status">{t.st_loading}</p>;
  if (read.phase === "error")
    return (
      <div role="alert">
        <p>{t.map_recovery_error}</p>
        <pre>{read.error}</pre>
      </div>
    );
  if (!read.snapshots.records.length) return <p>{t.map_recovery_empty}</p>;
  return (
    <div className="map-recovery__records">
      {read.snapshots.records.map((record, index) => (
        <details key={record.recordId}>
          <summary>
            {new Intl.NumberFormat().format(index + 1)}.{" "}
            {record.evidence === "currentObject"
              ? t.map_recovery_current
              : record.evidence === "publicationUnknown"
                ? t.map_recovery_unknown
                : t.map_recovery_invalid}
          </summary>
          {record.evidence === "invalidRecord" ? (
            <p>{t.map_recovery_invalid_note}</p>
          ) : (
            <div className="map-refresh-history__snapshots">
              <div>
                <h3>{t.map_history_before}</h3>
                {record.before === null ? (
                  <p>{t.map_recovery_no_before}</p>
                ) : (
                  <pre tabIndex={0} aria-label={t.map_history_before}>
                    {record.before}
                  </pre>
                )}
              </div>
              <div>
                <h3>{t.map_recovery_saved}</h3>
                <pre tabIndex={0} aria-label={t.map_recovery_saved}>
                  {record.after}
                </pre>
              </div>
            </div>
          )}
        </details>
      ))}
    </div>
  );
}

export default function MapRecoverySnapshots({
  t,
  vaultPath,
  vaultToken,
  mapKey,
}: {
  t: Strings;
  vaultPath: string;
  vaultToken: string;
  mapKey: string;
}) {
  const [opened, setOpened] = useState(false);
  const [retry, setRetry] = useState(0);
  const [read, setRead] = useState<RecoveryRead>({ phase: "idle" });
  useEffect(() => {
    if (!opened) return;
    return readMapRecovery(vaultPath, vaultToken, mapKey, setRead).cancel;
  }, [opened, vaultPath, vaultToken, mapKey, retry]);
  return (
    <details
      className="map-recovery"
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>{t.map_recovery_title}</summary>
      {opened && (
        <div aria-busy={read.phase === "loading"}>
          <p>{t.map_recovery_note}</p>
          <button
            type="button"
            className="btn"
            disabled={read.phase === "loading"}
            onClick={() => {
              setRead({ phase: "loading" });
              setRetry((value) => value + 1);
            }}
          >
            {t.map_history_reload}
          </button>
          <RecoverySnapshotList t={t} read={read} />
        </div>
      )}
    </details>
  );
}
