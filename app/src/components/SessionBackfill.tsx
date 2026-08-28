// Session backfill card (spec 2026-08-28). The vault's `sessions/` archive is
// the biggest un-mined input it has — on the owner's vault, 1,423 imported
// conversations had produced ten cited sources — because auto-ingest only ever
// walks `_inbox/`. This card promotes a batch of sessions into that queue and
// then gets out of the way: the normal ingest pass turns them into pages.
//
// The batch size IS the cost ceiling, chosen per press by the person paying
// for the runs, which is the roadmap's long-open "token cost per backfill run"
// question answered by the smallest thing that works.

import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { BackfillStatus } from "../lib/ipc";
import { useIngestStore } from "../stores/ingestStore";

const BATCH_SIZES = [5, 10, 25];

export default function SessionBackfill({ t }: { t: Strings }): JSX.Element | null {
  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const [batch, setBatch] = useState(10);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bumpInbox = useIngestStore((s) => s.bumpInboxRev);

  const refresh = useCallback(() => {
    void ipc
      .backfillStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(refresh, [refresh]);

  // Nothing to offer when the vault has no session archive at all — a fresh
  // install should not carry a card about an empty folder.
  if (!status || status.total === 0) return null;

  const promote = (): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    void ipc
      .promoteSessions(batch)
      .then((out) => {
        setNote(
          (t.bf_promoted ?? "{n} sessions queued for ingest").replace(
            "{n}",
            String(out.promoted.length),
          ),
        );
        // The pending _inbox list is a sibling card on this page.
        bumpInbox();
        refresh();
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const done = status.promoted;
  const left = status.eligible;

  return (
    <div className="card" style={{ marginTop: 16, padding: 14 }}>
      <div className="section-title" style={{ fontSize: 13.5, marginBottom: 6 }}>
        <Icon name="inbox" size={13} />{" "}
        {t.bf_title ?? "Session backfill"}
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 10px" }}>
        {t.bf_desc ??
          "Your coding sessions are archived but never became wiki pages. Promote a batch into the ingest queue."}
      </p>

      <div className="row" style={{ gap: 18, flexWrap: "wrap", marginBottom: 12 }}>
        <Stat label={t.bf_waiting ?? "waiting"} value={left} strong />
        <Stat label={t.bf_done ?? "wikified"} value={done} />
        <Stat label={t.bf_skipped ?? "too short"} value={status.too_small} />
        <Stat label={t.bf_held ?? "too large"} value={status.too_large} />
      </div>

      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div className="segmented">
          {BATCH_SIZES.map((n) => (
            <button
              key={n}
              type="button"
              className={batch === n ? "is-active" : ""}
              onClick={() => setBatch(n)}
              aria-pressed={batch === n}
            >
              {n}
            </button>
          ))}
        </div>
        <button
          className="btn btn-primary"
          onClick={promote}
          disabled={busy || left === 0}
        >
          {busy
            ? "…"
            : (t.bf_promote ?? "Queue the next {n}").replace("{n}", String(batch))}
        </button>
        {note ? (
          <span className="muted" style={{ fontSize: 12.5 }} role="status">
            {note}
          </span>
        ) : null}
        {error ? (
          <span style={{ fontSize: 12.5, color: "#dc2626" }} role="alert">
            {error}
          </span>
        ) : null}
      </div>

      {status.too_large > 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
          {(
            t.bf_held_note ??
            "{n} sessions are too large for a single pass and are being held, not skipped."
          ).replace("{n}", String(status.too_large))}
        </p>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
}: {
  label: string;
  value: number;
  strong?: boolean;
}): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: strong ? 20 : 16,
          fontWeight: 600,
          color: strong ? "var(--ink)" : "var(--ink-3)",
        }}
      >
        {value.toLocaleString()}
      </span>
      <span className="muted" style={{ fontSize: 11 }}>
        {label}
      </span>
    </div>
  );
}
