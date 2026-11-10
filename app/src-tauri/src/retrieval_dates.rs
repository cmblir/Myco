//! Date provenance for derived weekly/monthly passages. A bucket overlap is
//! useful for finding a file, but does not date every passage to the query day.
use crate::commands::DateRange;
use std::sync::OnceLock;

/// The frontend captures the viewer's local calendar day with UTC-second
/// bounds. A historical cutoff has no lower bound: this is not a one-day query.
pub(crate) fn historical_end(day: &DateRange) -> Result<i64, String> {
    if !crate::activity_recall::valid_range(day) || day.start != day.end {
        return Err("historical cutoff must name one valid local calendar day".into());
    }
    let utc_start = crate::importers::parse_iso8601(&format!("{}T00:00:00Z", day.start))
        .ok_or("invalid historical cutoff day")?;
    let (Some(start), Some(end)) = (day.start_epoch, day.end_epoch) else {
        return Err("historical cutoff requires captured viewer-local day bounds".into());
    };
    let duration = i128::from(end) - i128::from(start);
    let offset_start = (i128::from(start) - i128::from(utc_start)).abs();
    let offset_end = (i128::from(end) - i128::from(utc_start) - 86400).abs();
    if !(23 * 3600..=25 * 3600).contains(&duration) || offset_start > 14 * 3600 || offset_end > 14 * 3600 {
        return Err("historical cutoff bounds do not match the named local day".into());
    }
    Ok(end)
}

#[derive(Default)]
pub(crate) struct HistoricalOriginals {
    pub eligible: Vec<bool>,
    pub keys: Vec<Option<String>>,
}

/// Admit only current indexed original utterances with verified message
/// identity, role, date and exact chunk alignment. Date-looking body text,
/// projections, filenames and filesystem times cannot establish eligibility.
pub(crate) fn historical_originals(
    page: &str, content: &str, chunks: &[String], indexed_hashes: Option<&[u64]>, end: i64,
) -> HistoricalOriginals {
    let mut result = HistoricalOriginals { eligible: vec![false; chunks.len()], keys: vec![None; chunks.len()] };
    let hashes: Vec<_> = chunks.iter().map(|chunk| crate::embeddings::content_hash(chunk)).collect();
    if indexed_hashes != Some(hashes.as_slice()) { return result; }
    if let Some(events) = crate::retrieval_revisions::transcript_chunks(page, content, chunks) {
        for event in events.into_iter().filter(|event| event.timestamp < end) {
            result.eligible[event.section] = true;
            result.keys[event.section] = Some(event.key);
        }
    }
    result
}

#[derive(Clone, Debug)]
struct Span { first: String, last: String, precision: u8 }
fn span(name: &str) -> Option<Span> {
    let name=name.trim_end_matches(".md");
    let name=name.rsplit('/').next()?;
    if name.len()==10 && crate::distill::iso_week(name).is_some() {
        return Some(Span {first:name.into(),last:name.into(),precision:0});
    }
    if let Some((y,m,d))=crate::commands::iso_week_monday(name) {
        let last=crate::distill::days_from_civil(i64::from(y),m,d)+6;
        let (ey,em,ed,..)=crate::distill::civil_datetime(last*86400);
        return Some(Span {first:format!("{y:04}-{m:02}-{d:02}"),last:format!("{ey:04}-{em:02}-{ed:02}"),precision:1});
    }
    if crate::distill::is_month_name(name) {
        let y:i64=name[..4].parse().ok()?; let m:u32=name[5..].parse().ok()?;
        let (ny,nm)=if m==12 {(y+1,1)} else {(y,m+1)};
        let last=crate::distill::days_from_civil(ny,nm,1)-1;
        let (ey,em,ed,..)=crate::distill::civil_datetime(last*86400);
        return Some(Span {first:format!("{name}-01"),last:format!("{ey:04}-{em:02}-{ed:02}"),precision:2});
    }
    None
}
#[derive(Default)]
struct Block { chunks: Vec<usize>, level: Option<usize>, hints: Vec<Span>, invalid: bool }
fn add_hint(block: &mut Block, name: &str) {
    if let Some(s)=span(name) {block.hints.push(s);} else {block.invalid=true;}
}
fn path_hints(block: &mut Block, line: &str) {
    static PATH: OnceLock<regex::Regex>=OnceLock::new();
    let re=PATH.get_or_init(||regex::Regex::new(r"(?:daily|weekly|monthly)/[0-9]{4}-[0-9W-]+(?:\.md)?").unwrap());
    for m in re.find_iter(line) {add_hint(block,m.as_str());}
}
fn heading(line: &str) -> Option<(usize,&str)> {
    let n=line.bytes().take_while(|b|*b==b'#').count();
    (1..=6).contains(&n).then_some(())?;
    let rest=line.get(n..)?; if !rest.starts_with(' ') {return None;}
    Some((n,rest.trim()))
}
/// Only rollups use this rule. Transcript metadata is handled by the caller.
/// Full indexed chunks are retained or excluded; no source text or IDs change.
/// Finest explicit source dates override a coarse bucket. Unattributed bucket
/// summaries require the entire bucket to fit, rather than inventing a day.
pub(crate) fn rollup_mask(page: &str, chunks: &[String], range: &DateRange) -> Option<Vec<bool>> {
    if !page.starts_with("weekly/") && !page.starts_with("monthly/") {return None;}
    let mut mask=vec![false;chunks.len()];
    if !crate::activity_recall::valid_range(range) {return Some(mask);}
    let base=span(page);
    let mut blocks=Vec::new();let mut current=Block::default();let mut fence:Option<&str>=None;
    for (i,chunk) in chunks.iter().enumerate() {
        let first=chunk.lines().find(|l|!l.trim().is_empty()).unwrap_or("");
        if fence.is_none() {
            if let Some((level,text))=heading(first) {
                if !current.chunks.is_empty() {blocks.push(std::mem::take(&mut current));}
                current.level=Some(level);
                let token=text.split_whitespace().next().unwrap_or("");
                if token.as_bytes().get(4)==Some(&b'-') && token.as_bytes()[..4].iter().all(u8::is_ascii_digit) {add_hint(&mut current,token);}
                path_hints(&mut current,text);
            }
        }
        current.chunks.push(i);
        for line in chunk.lines().map(str::trim) {
            let marker=if line.starts_with("```") {Some("```")} else if line.starts_with("~~~") {Some("~~~")} else {None};
            if let Some(marker)=marker {
                if fence==Some(marker) {fence=None;} else if fence.is_none() {fence=Some(marker);}
                continue;
            }
            if fence.is_none() && line.starts_with("Source: [[") {path_hints(&mut current,line);}
        }
    }
    if !current.chunks.is_empty() {blocks.push(current);}
    let mut stack:Vec<(usize,Option<Span>)>=Vec::new();
    for block in blocks {
        if let Some(level)=block.level {while stack.last().is_some_and(|(n,_)|*n>=level) {stack.pop();}}
        let inherited=stack.last().map(|(_,s)|s.clone()).unwrap_or_else(||base.clone());
        let scope=if block.invalid {None} else if let Some(precision)=block.hints.iter().map(|s|s.precision).min() {
            let fine:Vec<_>=block.hints.iter().filter(|s|s.precision==precision).collect();
            Some(Span {first:fine.iter().map(|s|s.first.clone()).min().unwrap(),last:fine.iter().map(|s|s.last.clone()).max().unwrap(),precision})
        } else {inherited};
        let keep=scope.as_ref().is_some_and(|s|range.start<=s.first && s.last<=range.end);
        for i in block.chunks {mask[i]=keep;}
        if let Some(level)=block.level {stack.push((level,scope));}
    }
    Some(mask)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn original(turns: &[(&str, &str, &str)]) -> String {
        let metadata: Vec<_> = turns.iter().map(|(id,time,_)| serde_json::json!({"message_id":id,"timestamp":time,"original_role":"user"})).collect();
        let mut text=format!("---\nsource: fixture\nconversation_id: historical\nturn_metadata: {}\n---\n# Original\n\n",serde_json::to_string(&metadata).unwrap());
        for (_,_,body) in turns { text.push_str(&format!("**User:**\n\n{body}\n\n")); }
        text
    }
    #[test]
    fn historical_cutoff_keeps_all_earlier_originals_until_viewer_midnight() {
        let day=DateRange{start:"2026-10-08".into(),end:"2026-10-08".into(),
            start_epoch:crate::importers::parse_iso8601("2026-10-07T15:00:00Z"),
            end_epoch:crate::importers::parse_iso8601("2026-10-08T15:00:00Z")};
        let end=historical_end(&day).unwrap();
        let body=original(&[("old","2026-09-01T00:00:00Z","EARLIER ORIGINAL"),
            ("last","2026-10-08T14:59:59Z","LAST SECOND"),("future","2026-10-08T15:00:00Z","NEXT LOCAL DAY")]);
        let chunks=crate::embeddings::chunk_page(&body);
        let hashes: Vec<_>=chunks.iter().map(|c|crate::embeddings::content_hash(c)).collect();
        let mask=historical_originals("raw/conversations/fixture.md",&body,&chunks,Some(&hashes),end);
        let selected=chunks.iter().zip(mask.eligible).filter_map(|(c,keep)|keep.then_some(c.as_str())).collect::<Vec<_>>().join("\n");
        assert!(selected.contains("EARLIER ORIGINAL") && selected.contains("LAST SECOND"));
        assert!(!selected.contains("NEXT LOCAL DAY"));
        assert!(mask.keys.iter().any(Option::is_some));
    }
    #[test]
    fn historical_cutoff_rejects_untrusted_body_dates_and_stale_source_identity() {
        let body=original(&[("known","2026-10-08T00:00:00Z","As of 2026-10-01: a quoted claim.")]);
        let chunks=crate::embeddings::chunk_page(&body);
        let hashes: Vec<_>=chunks.iter().map(|c|crate::embeddings::content_hash(c)).collect();
        let end=crate::importers::parse_iso8601("2026-10-09T00:00:00Z").unwrap();
        for (page,text,indexed) in [("wiki/dated-copy.md",body.clone(),Some(hashes.clone())),
            ("raw/conversations/fixture.md",body.replace("2026-10-08T00:00:00Z","unknown"),Some(hashes.clone())),
            ("raw/conversations/fixture.md",body.clone(),None),
            ("raw/conversations/fixture.md",body.replace("a quoted claim","an edited claim"),Some(hashes.clone())),
            ("raw/conversations/fixture.md",body.replace("2026-10-08T00:00:00Z","2026-10-30T00:00:00Z"),Some(hashes.clone()))] {
            let current=crate::embeddings::chunk_page(&text);
            assert!(historical_originals(page,&text,&current,indexed.as_deref(),end).eligible.iter().all(|v|!*v));
        }
    }
    #[test]
    fn historical_cutoff_requires_valid_captured_day_and_not_arbitrary_epoch() {
        let mut day=DateRange{start:"2026-10-08".into(),end:"2026-10-08".into(),start_epoch:None,end_epoch:None};
        assert!(historical_end(&day).is_err());
        day.start_epoch=crate::importers::parse_iso8601("2026-10-08T00:00:00Z");
        day.end_epoch=crate::importers::parse_iso8601("2026-10-09T00:00:00Z");
        assert!(historical_end(&day).is_ok());
        day.end_epoch=crate::importers::parse_iso8601("2026-10-31T00:00:00Z");
        assert!(historical_end(&day).is_err());
        day.end="2026-10-09".into();assert!(historical_end(&day).is_err());
    }
    fn selected(text:&str,start:&str,end:&str)->Vec<String>{
        let chunks=crate::embeddings::chunk_page(text);
        let range=DateRange{start:start.into(),end:end.into(),start_epoch:None,end_epoch:None};
        let mask=rollup_mask("monthly/2026-09.md",&chunks,&range).unwrap();
        chunks.into_iter().zip(mask).filter_map(|(c,k)|k.then_some(c)).collect()
    }
    #[test]
    fn preserves_in_range_continuations_and_resets_sibling_scope() {
        let long="KEEP_LONG ".repeat(800);
        let doc=format!("# 2026-09\n\n#### 2026-W37 · daily/2026-09-08.md\n\n{long}\n\n##### Notes\n\nKEEP_CHILD\n\n#### 2026-W37 · daily/2026-09-11.md\n\nDROP_OTHER_DAY\n\n#### Undated sibling\n\nDROP_UNKNOWN_DAY\n");
        let got=selected(&doc,"2026-09-08","2026-09-08").join("\n");
        assert!(got.contains("KEEP_CHILD"));assert_eq!(got.matches("KEEP_LONG").count(),800);
        assert!(!got.contains("DROP_OTHER_DAY"));assert!(!got.contains("DROP_UNKNOWN_DAY"));
        let whole=selected(&doc,"2026-09-01","2026-09-30").join("\n");
        assert!(whole.contains("DROP_OTHER_DAY") && whole.contains("DROP_UNKNOWN_DAY"));
    }
    #[test]
    fn footer_dates_and_week_precision_do_not_become_a_day() {
        let doc="# 2026-09\n\n#### Named source\n\nKEEP_FOOTER\n\nSource: [[daily/2026-09-08.md]]\n\n#### 2026-W37\n\nWEEK_ONLY\n\nSource: [[weekly/2026-W37.md]]\n";
        let day=selected(doc,"2026-09-08","2026-09-08").join("\n");assert!(day.contains("KEEP_FOOTER"));assert!(!day.contains("WEEK_ONLY"));
        assert!(selected(doc,"2026-09-07","2026-09-13").join("\n").contains("WEEK_ONLY"));
    }
    #[test]
    fn code_examples_and_invalid_dates_cannot_reassign_a_passage() {
        let doc="# 2026-09\n\n#### daily/2026-09-11.md\n\n```text\n#### daily/2026-09-08.md\nSource: [[daily/2026-09-08.md]]\n```\n\nOUTSIDE\n\n#### daily/2026-09-99.md\n\nINVALID\n";
        assert!(selected(doc,"2026-09-08","2026-09-08").is_empty());
        assert!(!selected(doc,"2026-09-01","2026-09-30").join("\n").contains("INVALID"));
    }
    #[test]
    fn mixed_explicit_days_require_both_in_range() {
        let doc="#### Comparison\n\nBOTH_DAYS\n\nSource: [[daily/2026-09-08.md]], [[daily/2026-09-11.md]]\n";
        assert!(selected(doc,"2026-09-08","2026-09-08").is_empty());
        assert!(selected(doc,"2026-09-08","2026-09-11").join("\n").contains("BOTH_DAYS"));
    }
}
