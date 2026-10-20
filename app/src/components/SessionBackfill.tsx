// Backfill panel (Ingest → Sieve, step 5). The vault's `sessions/` archive is
// its biggest unopened input — 1,473 files → 719 distinct bodies, and
// backfill.rs had never run — so the panel is first-class here: the eligible
// count from the same ranker the Overview queue uses, the size buckets it
// refused, a batch size that IS the cost ceiling, and the model-call count
// that batch implies (plan 1 + write 1 per session). "Queue the next N" only
// COPIES into `_inbox/`; the inbox pass judges and ingests from there.

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { HarvestCandidates } from "../lib/ipc";
import { useIngestStore } from "../stores/ingestStore";
import { useVaultStore } from "../stores/vaultStore";
import { ActivityIcon } from "./ActivityPanel";

const BATCH_SIZES = [5, 10, 25, 50];
/** How deep the ranker looks — the largest batch, so "next 50" is real. */
const QUEUE_LIMIT = 50;

export default function SessionBackfill({
  t,
}: {
  t: Strings;
}): JSX.Element | null {
  const [accepted, setAccepted] = useState<{
    root: string;
    vaultToken: string;
    data: HarvestCandidates;
  } | null>(null);
  const [batch, setBatch] = useState(10);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanFailure, setScanFailure] = useState<{
    root: string;
    vaultToken: string;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const bumpInbox = useIngestStore((s) => s.bumpInboxRev);
  const root = useVaultStore((s) => s.currentVault?.path);
  const vaultToken = useVaultStore((s) => s.vaultToken);
  const isOpeningVault = useVaultStore((s) => s.isOpeningVault);
  const data = accepted && !isOpeningVault && accepted.root === root && accepted.vaultToken === vaultToken
    ? accepted.data : null;
  const scanError = scanFailure && !isOpeningVault && scanFailure.root === root && scanFailure.vaultToken === vaultToken
    ? scanFailure.message : null;
  const requests = useRef({ scan: 0, promote: 0 });

  const refresh = useCallback(async () => {
    if (!root || isOpeningVault) return;
    const request = ++requests.current.scan;
    const isCurrent = (): boolean => {
      const current = useVaultStore.getState();
      return (
        request === requests.current.scan &&
        !current.isOpeningVault &&
        current.currentVault?.path === root &&
        current.vaultToken === vaultToken
      );
    };
    if (!isCurrent()) return;
    setLoading(true);
    setScanFailure(null);
    try {
      const result = await ipc.harvestCandidates(QUEUE_LIMIT, root);
      if (isCurrent()) {
        setAccepted({ root, vaultToken, data: result });
        setError(null);
      }
    } catch (failure) {
      if (isCurrent()) {
        setAccepted(null);
        setScanFailure({ root, vaultToken, message: String(failure) });
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [root, vaultToken, isOpeningVault]);

  useEffect(() => {
    const counters = requests.current;
    counters.promote++;
    setAccepted(null);
    setNote(null);
    setError(null);
    setScanFailure(null);
    setBusy(false);
    void refresh();
    return () => {
      counters.scan++;
      counters.promote++;
    };
  }, [refresh]);

  if (!root || isOpeningVault) return null;
  const readFailed = data !== null && data.read_status !== "complete" && data.read_status !== "partial";
  const readIssues = data?.read_issues ?? [];
  const partialRead = data?.read_status === "partial";
  const readNotice = scanError || readFailed || partialRead ? (
    <div className="sv-bf-note is-error" role="alert" style={{ overflowWrap: "anywhere" }}>
      <p>{scanError ?? (readFailed ? t.hq_error : t.hq_read_partial)}</p>
      {readIssues.length ? <ul>{readIssues.map((issue, index) => (
        <li key={`${issue.path}:${issue.code}:${index}`}><code>{issue.path}</code>: {issue.message}</li>
      ))}</ul> : null}
    </div>
  ) : null;

  // A failed scan is unknown inventory; keep its recovery visible without candidates.
  if (!data || readFailed) {
    if (!scanError && !readFailed && !loading) return null;
    return <section className="sv-bf" aria-labelledby="sv-bf-title" data-testid="backfill-panel">
      <h2 id="sv-bf-title">{t.bf_title}</h2>
      {readNotice}
      {loading ? <p role="status">{t.hq_loading}</p> : null}
      <button type="button" className="btn" style={{ minWidth: 44, minHeight: 44 }} disabled={loading} aria-busy={loading} onClick={() => void refresh()}>
        {t.hq_retry}
      </button>
    </section>;
  }
  // Only a complete read may establish that the optional archive is empty.
  if (data.read_status === "complete" && data.total_scanned === 0 && !loading) return null;

  const eligible = data.items.length;
  const n = Math.min(batch, eligible);
  const readCount = (count: number): string => partialRead
    ? t.hq_read_lower_bound.replace("{n}", count.toLocaleString()) : count.toLocaleString();

  const promote = (): void => {
    if (!root || busy || loading) return;
    const request = ++requests.current.promote;
    const isCurrent = (): boolean => {
      const current = useVaultStore.getState();
      return (
        request === requests.current.promote &&
        !current.isOpeningVault &&
        current.currentVault?.path === root &&
        current.vaultToken === vaultToken
      );
    };
    if (!isCurrent()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    void (async () => {
      const origin = Object.freeze(await ipc.agentVaultSession());
      if (!isCurrent()) return null;
      if (origin.vaultPath !== root || !origin.openingToken)
        throw new Error(
          "The native backfill opening differs from the selected vault",
        );
      return ipc.harvestRun(
        data.items.slice(0, n).map((c) => c.path),
        root,
        origin,
      );
    })()
      .then((out) => {
        if (!out || !isCurrent()) return;
        const skipped =
          out.skipped.length > 0
            ? ` · ${t.sv_bf_skipped.replace("{n}", String(out.skipped.length))}`
            : "";
        setNote(t.bf_promoted.replace("{n}", String(out.copied)) + skipped);
        // The pending _inbox list is a channel row on this page.
        bumpInbox();
        void refresh();
      })
      .catch((err: unknown) => {
        if (isCurrent()) setError(String(err));
      })
      .finally(() => {
        if (isCurrent()) setBusy(false);
      });
  };

  return (
    <section
      className="sv-bf"
      aria-labelledby="sv-bf-title"
      data-testid="backfill-panel"
    >
      <div className="sv-bf-head">
        <ActivityIcon name="indexing" size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="sv-eyebrow">{t.sv_bf_eyebrow}</div>
          <h2 id="sv-bf-title">{t.bf_title}</h2>
          <p>
            {t.bf_desc}
            {data.read_status === "complete" && data.excluded.already_harvested === 0 ? (
              <> {t.hq_never_run}</>
            ) : null}
          </p>
        </div>
      </div>

      {readNotice}
      {loading ? <p role="status">{t.hq_loading}</p> : null}
      <button type="button" className="btn" style={{ minWidth: 44, minHeight: 44 }} disabled={loading || busy} aria-busy={loading} onClick={() => void refresh()}>
        {t.hq_retry}
      </button>

      <div className="sv-bf-stats">
        <Stat
          hero
          value={readCount(eligible)}
          label={t.sv_bf_eligible}
          sub={t.sv_bf_eligible_sub}
        />
        <Stat value={readCount(data.excluded.already_harvested)} label={t.bf_done} />
        <Stat value={readCount(data.excluded.too_small)} label={t.bf_skipped} />
        <Stat value={readCount(data.excluded.too_large)} label={t.bf_held} />
        <Stat value={readCount(data.distinct_bodies)} label={t.sv_bf_distinct} />
        <Stat value={readCount(data.total_scanned)} label={t.sv_bf_total} />
      </div>

      <div className="sv-bf-actions">
        <div className="sv-seg" role="group" aria-label={t.sv_bf_batch_label}>
          {BATCH_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              onClick={() => setBatch(size)}
              aria-pressed={batch === size}
            >
              {size}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn hq-btn"
          onClick={promote}
          disabled={busy || loading || n === 0}
          aria-busy={busy}
        >
          {t.bf_promote.replace("{n}", String(n))}
        </button>
        <span className="sv-bf-cost">
          {t.sv_bf_cost
            .replace("{calls}", String(n * 2))
            .replaceAll("{n}", String(n))}
        </span>
      </div>

      {note ? (
        <p className="sv-bf-note" role="status">
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="sv-bf-note is-error" role="alert">
          {error}
        </p>
      ) : null}
      {data.excluded.too_large > 0 ? (
        <p className="sv-bf-note">
          {t.bf_held_note.replace("{n}", readCount(data.excluded.too_large))}
        </p>
      ) : null}
    </section>
  );
}

function Stat({
  value,
  label,
  sub,
  hero,
}: {
  value: string;
  label: string;
  sub?: string;
  hero?: boolean;
}): JSX.Element {
  return (
    <div className={"sv-bf-stat" + (hero ? " is-hero" : "")}>
      <span className="sv-big">{value}</span>
      <div className="sv-l">{label}</div>
      {sub ? <div className="sv-s">{sub}</div> : null}
    </div>
  );
}
