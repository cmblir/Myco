//! Native record selection context; no timestamp establishes an action's time.

use crate::commands::DateRange;
use crate::wiki_claims::SourceSpan;
use serde::Serialize;

pub(crate) const VERSION: &str = "RecordPeriodContextV1";
pub(crate) const INSTRUCTIONS: &str = "recordPeriodContext is native record-selection metadata, not event time or proof of performed work. Distinguish in-period requests/plans/reports, original-supported event time, outside-period corrections and time-uncertain context. An in-period record can describe an old event; an outside-period record can explicitly report an in-period event. Retain outside/uncertain retractions and qualifications in required coverage without presenting them as work performed in the requested period. Unknown event time stays unknown. T-preamble and unknown speaker do not mean meaningless metadata: ordinary human notes can use those values. Use exact original wording to decide relevance. If only context and no supported qualifying activity remains, do not invent an activity answer. This sidecar cannot supply semantic approval or independent verification.";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodSpanCounts {
    pub in_period_spans: usize,
    pub outside_period_spans: usize,
    pub uncertain_spans: usize,
}
impl PeriodSpanCounts {
    pub(crate) fn add(&mut self, other: &Self) {
        self.in_period_spans += other.in_period_spans;
        self.outside_period_spans += other.outside_period_spans;
        self.uncertain_spans += other.uncertain_spans;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Relation {
    InPeriod,
    OutsidePeriod,
    Uncertain,
}
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum TimeBasis {
    Turn,
    Record,
    Unknown,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordPeriodSpan<'a> {
    span_id: &'a str,
    record_period_relation: Relation,
    record_time_basis: TimeBasis,
}
#[derive(Serialize)]
pub(crate) struct RecordPeriodContext<'a> {
    version: &'static str,
    spans: Vec<RecordPeriodSpan<'a>>,
    pub counts: PeriodSpanCounts,
}

/// A date-only record occupies a whole uncertain UTC day, not midnight alone.
pub(crate) fn record_interval(span: &SourceSpan) -> Option<(i64, i64)> {
    let value = span.turn_time().or_else(|| span.record_time())?;
    time_interval(value)
}
fn time_interval(value: &str) -> Option<(i64, i64)> {
    let day_only = value.len() == 10;
    let start = if day_only {
        crate::importers::parse_iso8601(&format!("{value}T00:00:00Z"))
    } else {
        crate::importers::parse_iso8601(value)
    }?;
    Some((start, start.checked_add(if day_only { 86_400 } else { 1 })?))
}

pub(crate) fn annotate<'a>(
    period: &DateRange,
    spans: impl IntoIterator<Item = &'a SourceSpan>,
) -> Result<RecordPeriodContext<'a>, String> {
    if !super::valid_range(period) {
        return Err("invalid native record period".into());
    }
    let (start, end) = match (period.start_epoch, period.end_epoch) {
        (Some(start), Some(end)) => (start, end),
        (None, None) => (
            time_interval(&period.start)
                .ok_or("invalid native period start")?
                .0,
            time_interval(&period.end)
                .ok_or("invalid native period end")?
                .1,
        ),
        _ => return Err("incomplete native period epoch bounds".into()),
    };
    let mut counts = PeriodSpanCounts::default();
    let mut ids = std::collections::BTreeSet::new();
    let spans = spans
        .into_iter()
        .map(|span| {
            if !ids.insert(span.id()) {
                return Err("native record period repeats an original span".into());
            }
            let basis = if span.turn_time().is_some() {
                TimeBasis::Turn
            } else if span.record_time().is_some() {
                TimeBasis::Record
            } else {
                TimeBasis::Unknown
            };
            let relation = match record_interval(span) {
                Some((first, last)) if first >= start && last <= end => Relation::InPeriod,
                Some((first, last)) if last <= start || first >= end => Relation::OutsidePeriod,
                _ => Relation::Uncertain,
            };
            match relation {
                Relation::InPeriod => counts.in_period_spans += 1,
                Relation::OutsidePeriod => counts.outside_period_spans += 1,
                Relation::Uncertain => counts.uncertain_spans += 1,
            }
            Ok(RecordPeriodSpan {
                span_id: span.id(),
                record_period_relation: relation,
                record_time_basis: basis,
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(RecordPeriodContext {
        version: VERSION,
        spans,
        counts,
    })
}

#[cfg(test)]
#[path = "period_context_tests.rs"]
mod tests;
