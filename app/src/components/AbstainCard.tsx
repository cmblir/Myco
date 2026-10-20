// Abstention as a first-class Ask answer: no hit cleared the relevance floor,
// so the turn says so in plain words (UX S30) and offers the next step — write
// the question into today's note, search again wider (without its period for
// a dated question, over sessions too, or both), or mark it for a later
// harvest. The numbers stay under "Details": the indexed pages, the floor, and
// the closest misses on a 0–1 gauge with the floor tick ("keywords only" for a
// lexical hit with no cosine). Nothing is quoted: the least-bad chunk is not
// evidence.

import type { JSX } from "react";
import { stem } from "../lib/graphData";
import { SURFACE_CLIPS } from "../lib/mascotClips";
import type { Strings } from "../lib/i18n";
import type { NearMiss } from "../lib/ipc";
import MascotClip from "./MascotClip";
import { TierChip } from "./SourceLadder";

/** The gauge runs 0..GAUGE_MAX, so the floor tick sits at ~62% of the track
 *  and a miss just under it visibly reads as "close" rather than pinned to
 *  the right edge. */
const GAUGE_MAX = 0.8;

export default function AbstainCard({
  t,
  id,
  indexedPages,
  floor,
  misses,
  harvested,
  onHarvest,
  noted,
  onOpenNoted,
  onNote,
  onWiden,
  onDropRange,
  range,
  explanation,
}: {
  t: Strings;
  id: string;
  /** Pages in the index — the pool the question was judged against. */
  indexedPages: number | null;
  floor: number;
  misses: NearMiss[];
  harvested: boolean;
  /** Absent when the gap is not the vault's to fill — a follow-up whose
   *  pronoun found nothing is not a harvest target. */
  onHarvest?: () => void;
  /** The question is in today's note: the button reads as done. */
  noted: boolean;
  /** Open that note on the question's line — given once the write returned,
   *  when the done button becomes the card's way to the note. */
  onOpenNoted?: () => void;
  /** Write the question into today's note. Absent for a follow-up, which
   *  means nothing on its own there. */
  onNote?: () => void;
  /** Search every scope. Absent when the turn already did. */
  onWiden?: () => void;
  /** Search again without the period; shown only with `range`. */
  onDropRange?: () => void;
  /** The dated question's window: the card then speaks of that period, not
   *  the whole index. */
  range?: { start: string; end: string };
  /** A known capability/scope limit instead of inferred note absence. */
  explanation?: string;
}): JSX.Element {
  const floorText = floor.toFixed(2);
  const tick = `${Math.round((floor / GAUGE_MAX) * 100)}%`;
  // "Similar notes came close" only when some did.
  const sub = explanation ?? (range
    ? t.q_abstain_range_sub.replace("{s}", range.start).replace("{e}", range.end)
    : misses.length
      ? t.q_abstain_sub
      : t.q_abstain_sub_none);
  const numbers = (
    range
      ? t.q_abstain_range_numbers.replace("{s}", range.start).replace("{e}", range.end)
      : t.q_abstain_numbers.replace("{n}", indexedPages === null ? "—" : String(indexedPages))
  ).replace("{floor}", floorText);
  return (
    <section className="ask-abstain" aria-labelledby={`${id}-h`}>
      <div className="ask-abshead">
        {/* MYCO looks and comes up empty, once; the title says so. */}
        <span className="ask-orb">
          <MascotClip {...SURFACE_CLIPS.abstain} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 id={`${id}-h`}>{range ? t.q_range_empty : t.q_abstain_title}</h2>
          <p className="ask-abssub">{sub}</p>
        </div>
      </div>
      <div className="ask-acts">
        {/* Written, it opens the note. aria-disabled while the write runs,
            not disabled: disabling the button being pressed drops keyboard
            focus to <body> (MissButton). */}
        {onNote ? (
          <button
            type="button"
            className="btn btn-primary"
            aria-live="polite"
            aria-disabled={(noted && !onOpenNoted) || undefined}
            onClick={noted ? onOpenNoted : onNote}
          >
            {noted
              ? `✓ ${t.q_abstain_noted}${onOpenNoted ? ` · ${t.home_open_daily}` : ""}`
              : t.q_abstain_note}
          </button>
        ) : null}
        {range && onDropRange ? (
          <button type="button" className="btn" onClick={onDropRange}>
            {t.q_abstain_widen_range}
          </button>
        ) : null}
        {onWiden ? (
          <button type="button" className="btn" onClick={onWiden}>
            {t.q_abstain_widen}
          </button>
        ) : null}
        {onHarvest ? (
          <button type="button" className="btn btn-ghost" disabled={harvested} onClick={onHarvest}>
            {harvested ? t.q_abstain_harvested : t.q_abstain_harvest}
          </button>
        ) : null}
      </div>
      {harvested ? (
        <div className="ask-receipt" role="status">
          <b>✓</b>
          <span>{t.q_abstain_receipt}</span>
        </div>
      ) : null}
      <details className="intake-disclosure ask-absdetails">
        <summary>{t.q_abstain_details}</summary>
        <p className="ask-absnums">{numbers}</p>
        <div className="ask-misses">
          <h3>{t.q_abstain_near}</h3>
          {misses.length ? (
            misses.map((m) => {
              // A server triple without a cosine shows its final score as the
              // number and no bar — the bar only ever plots the cosine the
              // floor was applied to.
              const sim = m.similarity;
              const width =
                typeof sim === "number" ? `${Math.round(Math.min(1, sim / GAUGE_MAX) * 100)}%` : "0%";
              const value =
                sim === null
                  ? t.q_abstain_lexical
                  : typeof sim === "number"
                    ? sim.toFixed(3)
                    : m.score_final.toFixed(3);
              return (
                <div key={m.page} className="ask-missrow">
                  <div style={{ minWidth: 0 }}>
                    <span className="ask-lstem" style={{ fontSize: 12.5 }}>
                      {stem(m.page)}
                    </span>{" "}
                    <TierChip t={t} tier={m.tier} />
                    <span className="ask-lpath">{m.page}</span>
                  </div>
                  <div className="ask-missbar" aria-hidden="true">
                    <i style={{ width }} />
                    <span
                      className="floor"
                      style={{ left: tick }}
                      title={t.q_abstain_floor_tick.replace("{floor}", floorText)}
                    />
                  </div>
                  <div className="ask-missnum">{value}</div>
                </div>
              );
            })
          ) : (
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              {t.q_abstain_none}
            </p>
          )}
          <p className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
            {t.q_abstain_gauge_note.replace("{floor}", floorText)}
          </p>
        </div>
      </details>
    </section>
  );
}
