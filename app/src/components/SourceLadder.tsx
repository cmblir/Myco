// Source ladder beside an extractive Ask answer: every retrieved page as one
// ranked row — a filled tier chip in its category colour, the tier weight,
// the quoted lines, the cosine, `RRF × prior = final` and the ▲▼ move against
// the unweighted order. Hover/focus on a row lights the answer line it backs
// and vice versa; the page owns `hot`. Also the tier-prior sliders (고급) that
// re-rank the ladders live and ride along with the next question.
// Given a limit, the ladder lists that many and opens all of them in a side
// sheet (UX S33).

import { Fragment, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { INTAKE_COPY } from "../lib/intakeCopy";
import { Icon } from "../lib/icons";
import { useModalFocus } from "./useModalFocus";
import { useUIStore } from "../stores/uiStore";
import "../styles/intake.css";
import type { CSSProperties, JSX, ReactNode } from "react";
import type { Strings } from "../lib/i18n";
import type { AskScope, HitTier, TierWeights } from "../lib/ipc";
import {
  DEFAULT_TIER_WEIGHTS,
  confidenceBand,
  tierColor,
  type ConfidenceBand,
  type SourceTier,
} from "../lib/extractive";
import type { LadderRow } from "../lib/ladder";
import { plainText } from "../lib/askLoop";
import { displayName } from "../lib/displayName";

export function bandLabel(t: Strings, band: ConfidenceBand): string {
  switch (band) {
    case "high":
      return t.q_cite_conf_high ?? "strong match";
    case "medium":
      return t.q_cite_conf_medium ?? "moderate match";
    case "low":
      return t.q_cite_conf_low ?? "weak match";
    case "lexical":
      return t.q_cite_conf_lexical ?? "keyword match";
  }
}

export function tierLabel(t: Strings, tier: SourceTier): string {
  switch (tier) {
    case "map":
      return t.q_cite_tier_map ?? "drafted map";
    case "digest":
      return t.q_cite_tier_digest ?? "daily digest";
    case "rollup":
      return t.q_cite_tier_rollup ?? "weekly rollup";
    case "monthly":
      return t.q_cite_tier_monthly ?? "monthly rollup";
    case "session":
      return t.q_cite_tier_session ?? "session log";
    case "source":
      return t.q_cite_tier_source ?? "imported source";
    case "note":
      return t.q_cite_tier_note ?? "your note";
  }
}

export function scopeLabel(t: Strings, scope: AskScope): string {
  switch (scope) {
    case "wiki":
      return t.q_scope_wiki;
    case "sessions":
      return t.q_scope_sessions;
    case "all":
      return t.q_scope_all;
  }
}

/** Filled tier chip. The colour is the app's fixed category meaning for the
 * tier (extractive.ts::tierColor); the stylesheet mixes it toward ink (light)
 * or white (dark) so the label keeps AA contrast on either theme. */
export function TierChip({
  t,
  tier,
  prior,
}: {
  t: Strings;
  tier: SourceTier;
  prior?: number;
}): JSX.Element {
  return (
    <span
      className="ask-badge"
      style={{ "--tc": tierColor(tier) } as CSSProperties}
    >
      {tierLabel(t, tier)}
      {prior === undefined ? null : <b>×{prior.toFixed(2)}</b>}
    </span>
  );
}

interface LadderProps {
  t: Strings;
  /** Unique per turn — ids for the heading and the screen-reader legend. */
  id: string;
  rows: LadderRow[];
  /** Rows listed here; past it, a button opens every row in a side sheet. */
  limit?: number;
  /** How many top rows the answer quotes (the citation pills). */
  quoted: number;
  floor: number;
  /** Page currently lit from either side, or null. */
  hot: string | null;
  onHot: (page: string | null) => void;
  onOpen: (page: string) => void;
  /** More of the search shown with the numbers (the turn's retrieval
   *  stepper), so "search details" is one toggle per answer. */
  details?: ReactNode;
  /** In the side sheet: its close button, in the header. */
  onClose?: () => void;
}

export default function SourceLadder({
  t,
  id,
  rows,
  limit,
  quoted,
  floor,
  hot,
  onHot,
  onOpen,
  details,
  onClose,
}: LadderProps): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const copy = INTAKE_COPY[lang];
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const shown = limit === undefined ? rows : rows.slice(0, limit);
  const moved = rows.reduce(
    (a, b) => (Math.abs(b.rankChange) > Math.abs(a.rankChange) ? b : a),
    rows[0],
  );
  const movedIdx = moved ? rows.indexOf(moved) : -1;
  const lead =
    !moved || moved.rankChange === 0
      ? t.q_ladder_lead_same
      : t.q_ladder_lead_moved
          .replace("{stem}", displayName(moved.stem))
          .replace("{tier}", tierLabel(t, moved.tier))
          .replace("{before}", String(movedIdx + 1 + moved.rankChange))
          .replace("{after}", String(movedIdx + 1));
  const pct = (v: number | null): string =>
    v === null ? "—" : `${Math.round(v * 100)}%`;
  return (
    <section
      className={"ask-panel ask-sources" + (detailsOpen ? " is-detailed" : "")}
      aria-labelledby={`${id}-h`}
    >
      <header>
        <h3 id={`${id}-h`}>{copy.sourcesTitle}</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {t.q_ladder_count
            .replace("{n}", String(rows.length))
            .replace("{c}", String(Math.min(quoted, rows.length)))}
        </span>
        {onClose ? (
          <button
            type="button"
            className="btn btn-ghost ask-sheet__close"
            aria-label={t.ui_close}
            title={t.ui_close}
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        ) : null}
      </header>
      <div className="body">
        <ul className="ask-ladder">
          {detailsOpen ? (
            <li
              className={`ask-lead${moved && moved.rankChange !== 0 ? " warn" : ""}`}
            >
              {lead}
            </li>
          ) : null}
          {shown.map((r, i) => {
            const band = confidenceBand(r.similarity);
            // The chip tooltips carry the exact cosine and the floor it cleared.
            const tip =
              r.similarity === null
                ? (
                    t.q_cite_conf_lexical_tip ??
                    "{page} — keyword match only, so there is no similarity score for it"
                  ).replace("{page}", r.page)
                : (
                    t.q_cite_conf_tip ??
                    "{page} — similarity {sim} (dense cosine; passages below {floor} are not shown)"
                  )
                    .replace("{page}", r.page)
                    .replace("{sim}", r.similarity.toFixed(3))
                    .replace("{floor}", floor.toFixed(2));
            const delta =
              r.rankChange > 0
                ? {
                    cls: "up",
                    text: `▲${r.rankChange}`,
                    title: t.q_ladder_up.replace("{n}", String(r.rankChange)),
                  }
                : r.rankChange < 0
                  ? {
                      cls: "down",
                      text: `▼${-r.rankChange}`,
                      title: t.q_ladder_down.replace(
                        "{n}",
                        String(-r.rankChange),
                      ),
                    }
                  : { cls: "same", text: "–", title: t.q_ladder_same };
            return (
              <li key={r.page}>
                <button
                  type="button"
                  className={`ask-lrow${hot === r.page ? " hot" : ""}`}
                  title={detailsOpen ? tip : r.stem}
                  aria-describedby={detailsOpen ? `${id}-sr` : undefined}
                  onMouseEnter={() => onHot(r.page)}
                  onMouseLeave={() => onHot(null)}
                  onFocus={() => onHot(r.page)}
                  onBlur={() => onHot(null)}
                  onClick={() => onOpen(r.page)}
                >
                  <span className="ask-lrank">{i + 1}</span>
                  <span style={{ minWidth: 0 }}>
                    <span className="ask-lhead">
                      <span className="ask-lstem">{displayName(r.stem)}</span>
                      <TierChip
                        t={t}
                        tier={r.tier}
                        prior={detailsOpen ? r.prior : undefined}
                      />
                      {r.archived ? (
                        <span className="ask-coldflag">
                          {t.q_ladder_archived}
                        </span>
                      ) : null}
                    </span>
                    {detailsOpen ? (
                      <span className="ask-lpath">{r.page}</span>
                    ) : null}
                    <span className="ask-lquote">{plainText(r.quote)}</span>
                  </span>
                  <span className="ask-lnum">
                    {detailsOpen ? (
                      <span className={`ask-lsim b-${band}`}>
                        {pct(r.similarity)}
                      </span>
                    ) : null}
                    <span className="muted" style={{ fontSize: 10 }}>
                      {bandLabel(t, band)}
                    </span>
                    {detailsOpen ? (
                      <>
                        <span className="ask-lmath">
                          {r.rrf.toFixed(4)} × {r.prior.toFixed(2)}
                        </span>
                        <span
                          className="ask-lmath"
                          style={{ color: "var(--ink-2)" }}
                        >
                          = {r.final.toFixed(4)}
                        </span>
                        <span
                          className={`ask-ldelta ${delta.cls}`}
                          title={delta.title}
                        >
                          {delta.text}
                        </span>
                      </>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {shown.length < rows.length ? (
          <button
            type="button"
            className="btn ask-sources__all"
            aria-haspopup="dialog"
            onClick={() => setSheetOpen(true)}
          >
            {t.q_ladder_all.replace("{n}", String(rows.length))}
            <Icon name="chevR" size={14} />
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost ask-sources__toggle"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {copy.searchDetails}
        </button>
        {detailsOpen ? (
          <>
            {details}
            <p id={`${id}-sr`} className="ask-sr">
              {t.q_ladder_sr}
            </p>
          </>
        ) : null}
      </div>
      {sheetOpen
        ? createPortal(
            <SourcesSheet
              t={t}
              id={`${id}-all`}
              rows={rows}
              quoted={quoted}
              floor={floor}
              hot={hot}
              onHot={onHot}
              // The note opens in place of Ask, so the sheet goes first.
              onOpen={(page) => {
                setSheetOpen(false);
                onOpen(page);
              }}
              onClose={() => setSheetOpen(false)}
            />,
            document.body,
          )
        : null}
    </section>
  );
}

/** Every source of one answer, in a sheet at the window's right edge. A
 *  portal: the Ask column is a size container, which would hold a fixed box
 *  inside it. The search details stay with the rail's ladder. */
function SourcesSheet(props: LadderProps & { onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const { onKeyDown } = useModalFocus(ref, { open: true, onEscape: props.onClose });
  return (
    <div className="myco-modal__backdrop ask-sheet-backdrop" onClick={props.onClose}>
      <div
        ref={ref}
        className="ask-sheet"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${props.id}-h`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <SourceLadder {...props} />
      </div>
    </div>
  );
}

/** The five sliders: rollup follows digest until it is measured separately
 *  (extractive.ts::DEFAULT_TIER_WEIGHTS). */
const SLIDERS: readonly HitTier[] = [
  "note",
  "map",
  "digest",
  "session",
  "source",
];
const ALL_ONE: TierWeights = {
  note: 1,
  map: 1,
  digest: 1,
  rollup: 1,
  session: 1,
  source: 1,
};

export function TierPriorPanel({
  t,
  id,
  weights,
  onChange,
}: {
  t: Strings;
  id: string;
  weights: TierWeights;
  onChange: (weights: TierWeights) => void;
}): JSX.Element {
  const allOne =
    SLIDERS.every((tier) => weights[tier] === 1) && weights.rollup === 1;
  const set = (tier: HitTier, v: number): void =>
    onChange({
      ...weights,
      [tier]: v,
      ...(tier === "digest" ? { rollup: v } : {}),
    });
  return (
    <section className="ask-panel" aria-labelledby={`${id}-h`}>
      <header>
        <h3 id={`${id}-h`}>{t.q_prior_title}</h3>
        <span
          className="muted"
          style={{ fontSize: 12.5, fontFamily: "var(--font-mono)" }}
        >
          {t.q_prior_formula}
        </span>
      </header>
      <div className="body" style={{ padding: "12px 16px 14px" }}>
        <div className="ask-prior">
          {SLIDERS.map((tier) => (
            <Fragment key={tier}>
              <label htmlFor={`${id}-${tier}`}>
                <TierChip t={t} tier={tier} />
              </label>
              <input
                id={`${id}-${tier}`}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={weights[tier]}
                aria-label={t.q_prior_slider.replace(
                  "{tier}",
                  tierLabel(t, tier),
                )}
                onChange={(e) => set(tier, Number(e.target.value))}
              />
              <output htmlFor={`${id}-${tier}`}>
                {weights[tier].toFixed(2)}
              </output>
            </Fragment>
          ))}
        </div>
        <div className="ask-priorfoot">
          <button
            type="button"
            className="btn btn-ghost"
            aria-pressed={allOne}
            onClick={() => onChange(ALL_ONE)}
          >
            {t.q_prior_app}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange(DEFAULT_TIER_WEIGHTS)}
          >
            {t.q_prior_defaults}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          {t.q_prior_next}
        </p>
      </div>
    </section>
  );
}
