// Abstention as a first-class Ask answer: no hit cleared the relevance floor,
// so the turn says so — the stop asset, the closest misses on a 0–1 gauge
// with the floor tick ("keywords only" for a lexical hit with no cosine), and
// two ways forward: record the gap as a harvest target, or widen the scope to
// sessions and search again. Nothing is quoted: the least-bad chunk is not
// evidence.

import type { JSX } from "react";
import stopPng from "../assets/activity/stop.png";
import { stem } from "../lib/graphData";
import type { Strings } from "../lib/i18n";
import type { NearMiss } from "../lib/ipc";
import { TierChip } from "./SourceLadder";

/** The gauge runs 0..GAUGE_MAX, so the floor tick sits at ~62% of the track
 *  and a miss just under it visibly reads as "close" rather than pinned to
 *  the right edge. */
const GAUGE_MAX = 0.8;

export default function AbstainCard({
  t,
  id,
  question,
  indexedPages,
  floor,
  misses,
  harvested,
  onHarvest,
  onWiden,
}: {
  t: Strings;
  id: string;
  question: string;
  /** Pages in the index — the pool the question was judged against. */
  indexedPages: number | null;
  floor: number;
  misses: NearMiss[];
  harvested: boolean;
  onHarvest: () => void;
  /** Absent when the turn already ran over every scope. */
  onWiden?: () => void;
}): JSX.Element {
  const floorText = floor.toFixed(2);
  const tick = `${Math.round((floor / GAUGE_MAX) * 100)}%`;
  return (
    <section className="ask-abstain" aria-labelledby={`${id}-h`}>
      <div className="ask-abshead">
        <img className="ask-orb" src={stopPng} alt="" width={112} height={112} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 id={`${id}-h`}>{t.q_abstain_title}</h2>
          <p className="ask-abssub">
            {t.q_abstain_sub
              .replace("{q}", question)
              .replace("{n}", indexedPages === null ? "—" : String(indexedPages))
              .replace("{floor}", floorText)}
          </p>
        </div>
      </div>
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
      <div className="ask-acts">
        <button type="button" className="btn" disabled={harvested} onClick={onHarvest}>
          {harvested ? t.q_abstain_harvested : t.q_abstain_harvest}
        </button>
        {onWiden ? (
          <button type="button" className="btn" onClick={onWiden}>
            {t.q_abstain_widen}
          </button>
        ) : null}
        <span className="muted" style={{ fontSize: 11.5 }}>
          {t.q_abstain_foot}
        </span>
      </div>
      {harvested ? (
        <div className="ask-receipt" role="status">
          <b>✓</b>
          <span>{t.q_abstain_receipt}</span>
        </div>
      ) : null}
    </section>
  );
}
