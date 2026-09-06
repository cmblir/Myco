// Backfill panel (Ingest → Sieve, step 5). The vault's `sessions/` archive is
// its biggest unopened input — 1,473 files → 719 distinct bodies, and
// backfill.rs had never run — so the panel is first-class here: the eligible
// count from the same ranker the Overview queue uses, the size buckets it
// refused, a batch size that IS the cost ceiling, and the model-call count
// that batch implies (plan 1 + write 1 per session). "Queue the next N" only
// COPIES into `_inbox/`; the inbox pass judges and ingests from there.

import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { HarvestCandidates } from "../lib/ipc";
import { useIngestStore } from "../stores/ingestStore";
import { ActivityIcon } from "./ActivityPanel";

const BATCH_SIZES = [5, 10, 25, 50];
/** How deep the ranker looks — the largest batch, so "next 50" is real. */
const QUEUE_LIMIT = 50;

export default function SessionBackfill({ t }: { t: Strings }): JSX.Element | null {
  const [data, setData] = useState<HarvestCandidates | null>(null);
  const [batch, setBatch] = useState(10);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bumpInbox = useIngestStore((s) => s.bumpInboxRev);

  const refresh = useCallback(() => {
    void ipc
      .harvestCandidates(QUEUE_LIMIT)
      .then(setData)
      .catch(() => setData(null));
  }, []);

  useEffect(refresh, [refresh]);

  // Nothing to offer when the vault has no session archive at all — a fresh
  // install should not carry a panel about an empty folder.
  if (!data || data.total_scanned === 0) return null;

  const eligible = data.items.length;
  const n = Math.min(batch, eligible);

  const promote = (): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    void ipc
      .harvestRun(data.items.slice(0, n).map((c) => c.path))
      .then((out) => {
        const skipped =
          out.skipped.length > 0
            ? ` · ${t.sv_bf_skipped.replace("{n}", String(out.skipped.length))}`
            : "";
        setNote(t.bf_promoted.replace("{n}", String(out.copied)) + skipped);
        // The pending _inbox list is a channel row on this page.
        bumpInbox();
        refresh();
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="sv-bf" aria-labelledby="sv-bf-title" data-testid="backfill-panel">
      <div className="sv-bf-head">
        <ActivityIcon name="indexing" size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="sv-eyebrow">{t.sv_bf_eyebrow}</div>
          <h2 id="sv-bf-title">{t.bf_title}</h2>
          <p>
            {t.bf_desc}
            {data.excluded.already_harvested === 0 ? <> {t.hq_never_run}</> : null}
          </p>
        </div>
      </div>

      <div className="sv-bf-stats">
        <Stat
          hero
          value={eligible}
          label={t.sv_bf_eligible}
          sub={t.sv_bf_eligible_sub}
        />
        <Stat value={data.excluded.already_harvested} label={t.bf_done} />
        <Stat value={data.excluded.too_small} label={t.bf_skipped} sub="backfill.rs::MIN_BYTES" />
        <Stat value={data.excluded.too_large} label={t.bf_held} sub="backfill.rs::MAX_BYTES" />
        <Stat value={data.distinct_bodies} label={t.sv_bf_distinct} />
        <Stat value={data.total_scanned} label={t.sv_bf_total} sub="sessions/" />
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
          disabled={busy || n === 0}
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
          {t.bf_held_note.replace("{n}", String(data.excluded.too_large))}
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
  value: number;
  label: string;
  sub?: string;
  hero?: boolean;
}): JSX.Element {
  return (
    <div className={"sv-bf-stat" + (hero ? " is-hero" : "")}>
      <span className="sv-big">{value.toLocaleString()}</span>
      <div className="sv-l">{label}</div>
      {sub ? <div className="sv-s">{sub}</div> : null}
    </div>
  );
}
