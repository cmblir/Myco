import type { CitationEvidence } from "../lib/citationEvidence";
import { GUIDED_QUESTION_COPY } from "../lib/guidedQuestion";
// The Ask page's 기록 (UX S36): this device's past questions for the open
// vault, newest first, with a search field. Opening a row shows the turn as
// the page showed it, read back from the log — never asked again.

import { useState } from "react";
import type { JSX } from "react";
import type { Lang, Strings } from "../lib/i18n";
import type { AskRecord } from "../lib/ipc";
import { askedAgo, matchHistory } from "../lib/askHistory";
import { scopeLabel } from "./SourceLadder";
import Viewer from "./Viewer";
import AskEvidenceCoverage from "./AskEvidenceCoverage";
import AskExecutionDetails from "./AskExecutionDetails";
import { readAskSearchContext } from "../lib/askSearchContext";

export default function AskHistory({
  t,
  lang,
  records,
  error,
  now = Date.now(),
  onOpenStem,
}: {
  t: Strings;
  lang: Lang;
  /** Oldest first, as the log holds them. */
  records: AskRecord[];
  /** The log could not be read. */
  error: string | null;
  now?: number;
  /** A [[link]] in a past answer. */
  onOpenStem: (target: string, evidence?: CitationEvidence) => void;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  if (!records.length && !error) return null;
  const shown = matchHistory(records, query);
  return (
    // Folded: one "기록 · N" line at the top, so the question field stays
    // near the top of a fresh page however long the history is.
    <details className="intake-disclosure ask-history">
      <summary>
        {t.q_history} · {records.length}
      </summary>
      {error ? (
        <p className="ask-history__error" role="alert">
          {t.q_history_load_failed} <span className="muted">{error}</span>
        </p>
      ) : null}
      {records.length ? (
        <>
          <input
            type="search"
            className="input ask-history__search"
            aria-label={t.q_history_search}
            placeholder={t.q_history_search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {shown.length ? (
            <ul className="ask-history__list">
              {shown.map((rec) => (
                <HistoryRow
                  key={`${rec.at}\u0000${rec.q}`}
                  t={t}
                  lang={lang}
                  rec={rec}
                  now={now}
                  onOpenStem={onOpenStem}
                />
              ))}
            </ul>
          ) : (
            <p className="muted ask-history__none">{t.q_history_none}</p>
          )}
        </>
      ) : null}
    </details>
  );
}

/** What a past turn searched, as its chip says it: the note it ran over
 *  ("Ask this note"), else its scope; null for neither. */
export function scopeChipOf(t: Strings, rec: AskRecord): string | null {
  if (rec.note) return t.q_note_scope_chip.replace("{note}", rec.note.title);
  return rec.scope ? t.q_scope_chip.replace("{scope}", scopeLabel(t, rec.scope)) : null;
}

/** One past turn: the question and its outcome in the row; the answer only
 *  once opened, so 500 rows never render 500 answers. */
function HistoryRow({
  t,
  lang,
  rec,
  now,
  onOpenStem,
}: {
  t: Strings;
  lang: Lang;
  rec: AskRecord;
  now: number;
  onOpenStem: (target: string, evidence?: CitationEvidence) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const context = readAskSearchContext(rec.searchContext);
  const badge = rec.error
    ? t.q_history_failed
    : rec.stopped
      ? t.q_stopped
      : rec.abstained && !context?.periodClarification
        ? rec.abstainReason === "model_evidence" ? t.q_model_evidence_title : t.q_history_abstained
        : null;
  return (
    <li>
      <details className="ask-hrow" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <span className="ask-hrow__q">{rec.q}</span>
          <span className="ask-hrow__meta">
            <time dateTime={new Date(rec.at).toISOString()}>{askedAgo(rec.at, now, lang)}</time>
            {rec.cited.length ? (
              <span>{t.q_history_cited.replace("{n}", String(rec.cited.length))}</span>
            ) : null}
            {badge ? <span className="chip">{badge}</span> : null}
            {!badge && context?.packing?.omittedPassages ? <span className="chip">{t.q_context_packing_badge}</span> : null}
            {context?.periodClarification ? <span className="chip">{t.q_history_period_needed}</span> : null}
          </span>
        </summary>
        {open ? <HistoryAnswer t={t} lang={lang} rec={rec} onOpenStem={onOpenStem} /> : null}
      </details>
    </li>
  );
}


/** Lazy body for a reopened saved turn; opening never reruns retrieval or generation. */
export function HistoryAnswer({t,lang,rec,onOpenStem}: {
  t: Strings; lang: Lang; rec: AskRecord;
  onOpenStem: (target: string, evidence?: CitationEvidence) => void;
}): JSX.Element {
  const chip=scopeChipOf(t,rec),context=readAskSearchContext(rec.searchContext);
  return <div className="ask-hrow__body">
    <div className="row" style={{gap:6,flexWrap:"wrap"}}>
      {chip ? <span className="chip">{chip}</span> : null}
      {context?.guidedQuestion ? <span className="chip">{GUIDED_QUESTION_COPY[lang].intents[context.guidedQuestion.intent]} · {context.guidedQuestion.subject}{context.guidedQuestion.asOf ? ` · ${context.guidedQuestion.asOf}` : ""}</span> : null}
      {context?.range ? <span className="chip">{t.q_range_chip.replace("{s}",context.range.start).replace("{e}",context.range.end)}</span> : null}
      {context?.rangeIgnored ? <span className="chip">{t.q_range_unrestricted}</span> : null}
      {context?.periodClarification ? <span className="chip">{t.q_history_period_needed}</span> : null}
    </div>
    {context?.activityQuestion && context.activityQuestion !== rec.q ?
      <p className="muted">{t.q_history_original_question.replace("{question}",context.activityQuestion)}</p> : null}
    {rec.error ? <p className="ask-hrow__error">{rec.error}</p>
      : rec.stopped ? <p className="muted">{t.q_stopped_sub}</p>
      : rec.abstained && !context?.periodClarification ? <p className="muted">{rec.abstainReason === "model_evidence" ? t.q_model_evidence_insufficient : t.q_abstain_title}</p>
      : <div className="prose"><Viewer content={rec.a} onLinkClick={target=>onOpenStem(target,rec.citationEvidence)} displayNames /></div>}
    {!rec.error && !rec.stopped ? <AskEvidenceCoverage t={t} lang={lang} context={context} /> : null}
    <AskExecutionDetails t={t} value={rec.execution} />
    {context?.paths?.length ? <details className="intake-disclosure">
      <summary>{t.q_history_searched_paths.replace("{n}",new Intl.NumberFormat(lang).format(context.paths.length))}</summary>
      <ul>{context.paths.map((path,index)=><li key={`${path}#${index}`}>{path}</li>)}</ul>
    </details> : null}
  </div>;
}
