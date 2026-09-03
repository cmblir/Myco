// Wikilink parser. The regex matches `[[target]]` and `[[target|display]]`
// non-greedily inside a single line. The display alias is dropped so the
// returned vector contains only canonical link targets, in the order they
// appear in the source.

use std::path::Path;

use regex::Regex;
use std::sync::OnceLock;

fn wikilink_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\]\n]+?)\]\]").expect("static regex"))
}

pub fn parse_links_from_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for cap in wikilink_regex().captures_iter(text) {
        if let Some(inner) = cap.get(1) {
            let raw = inner.as_str();
            let target = raw.split('|').next().unwrap_or(raw);
            // `[[Note#Heading]]` links to Note; a bare `[[#Heading]]` links nowhere.
            let target = target.split('#').next().unwrap_or(target).trim();
            // A source written as `[[name\]]` (escaped closing bracket) leaves the
            // backslash INSIDE the capture, since the regex stops at the first
            // literal `]`. Obsidian never treats `\` as part of a link name, so
            // strip it here rather than let it become a permanently "missing"
            // page named e.g. `transformer-decoder-only\` in the gap panel.
            let target = target.trim_end_matches('\\').trim();
            if !target.is_empty() {
                out.push(target.to_string());
            }
        }
    }
    out
}

pub fn parse_links(path: &str) -> Result<Vec<String>, String> {
    let resolved = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed for {path}: {e}"))?;
    let raw = std::fs::read_to_string(&resolved).map_err(|e| format!("read failed: {e}"))?;
    Ok(parse_links_from_text(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_link() {
        let links = parse_links_from_text("see [[note-a]] for context");
        assert_eq!(links, vec!["note-a"]);
    }

    #[test]
    fn parses_aliased_link() {
        let links = parse_links_from_text("[[note-a|Note A]]");
        assert_eq!(links, vec!["note-a"]);
    }

    #[test]
    fn parses_multiple_links() {
        let links = parse_links_from_text("[[a]] then [[b|B]] and [[c]]");
        assert_eq!(links, vec!["a", "b", "c"]);
    }

    #[test]
    fn ignores_unclosed_brackets() {
        let links = parse_links_from_text("[[unclosed and [[ok]]");
        assert_eq!(links, vec!["unclosed and [[ok"]);
    }

    #[test]
    fn ignores_links_spanning_newlines() {
        let links = parse_links_from_text("[[broken\nover-lines]]");
        assert_eq!(links, Vec::<String>::new());
    }

    #[test]
    fn skips_empty_targets() {
        let links = parse_links_from_text("[[ ]] and [[real]]");
        assert_eq!(links, vec!["real"]);
    }

    #[test]
    fn strips_trailing_backslash_from_an_escaped_close_bracket() {
        let links =
            parse_links_from_text("see [[transformer-decoder-only\\]] and [[bookcorpus\\]]");
        assert_eq!(links, vec!["transformer-decoder-only", "bookcorpus"]);
    }

    #[test]
    fn strips_heading_anchor() {
        assert_eq!(parse_links_from_text("[[note#Sec]]"), vec!["note"]);
        assert_eq!(parse_links_from_text("[[note#Sec|alias]]"), vec!["note"]);
        assert!(parse_links_from_text("[[#only]]").is_empty());
    }
}
