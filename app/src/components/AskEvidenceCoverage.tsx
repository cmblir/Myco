import type { JSX } from "react";
import type { Lang, Strings } from "../lib/i18n";
import { readAskSearchContext, type AskSearchContext, type AskActivityCoverage } from "../lib/askSearchContext";

/** Both the live answer and a reopened history row use the same coverage facts. */
export default function AskEvidenceCoverage({t,lang,context,activity}: {
  t: Strings; lang: Lang; context?: AskSearchContext; activity?: AskActivityCoverage;
}): JSX.Element | null {
  const saved = readAskSearchContext(context);
  const coverage = activity ?? saved?.activityCoverage;
  const packing = saved?.packing;
  const omitted = Boolean(packing?.omittedPassages);
  const historical = saved?.historical;
  const hasHistoricalExclusions = Boolean(historical && (historical.afterCutoff || historical.dateUnverified));
  if (!coverage && !omitted && !hasHistoricalExclusions) return null;
  const number = (value: number) => new Intl.NumberFormat(lang).format(value);
  return <div className="muted" style={{fontSize:"0.8125rem",marginBlock:"0.75rem"}}>
    {historical && hasHistoricalExclusions ? <p data-testid="ask-historical-exclusions" role="status" style={{margin:0}}>
      {t.q_historical_exclusions.replace("{date}",historical.asOf).replace("{after}",number(historical.afterCutoff)).replace("{undated}",number(historical.dateUnverified))}
    </p> : null}
    {coverage ? <p data-testid="ask-activity-coverage" style={{margin:0}}>
      {t.q_activity_coverage.replace("{scanned}",number(coverage.scannedPages)).replace("{sources}",number(coverage.sources))}
      {coverage.incomplete || omitted ? ` · ${t.q_activity_limited}` : ""}
    </p> : null}
    {packing && omitted ? <p data-testid="ask-context-coverage" role="status" style={{margin:0}}>
      {t.q_context_packing_limited.replace("{selected}",number(packing.selectedPassages)).replace("{omitted}",number(packing.omittedPassages))}
      {packing.omittedOnIncludedPages > 0 ? ` ${t.q_context_packing_same_page.replace("{n}",number(packing.omittedOnIncludedPages))}` : ""}
    </p> : null}
  </div>;
}
