//! Bounded pure-function memo for the isolated debug diagnostic. File reads,
//! source revisions, scope/date admission and index checks are never cached.
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
const LIMIT: usize = 16 * 1024 * 1024;
const ENTRIES: usize = 128;
#[derive(Default)]
struct Cache {
    entries: VecDeque<(String, Vec<String>, usize)>,
    bytes: usize,
}
impl Cache {
    fn find(&self, text: &str) -> Option<Vec<String>> {
        self.entries
            .iter()
            .find(|(input, _, _)| input == text)
            .map(|(_, chunks, _)| chunks.clone())
    }
    fn insert(&mut self, text: &str, chunks: &[String], limit: usize) {
        let size = text.len() + chunks.iter().map(String::len).sum::<usize>();
        if size > limit || self.entries.iter().any(|(input, _, _)| input == text) {
            return;
        }
        while self.bytes + size > limit || self.entries.len() >= ENTRIES {
            let Some((_, _, bytes)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= bytes;
        }
        self.entries.push_back((text.into(), chunks.to_vec(), size));
        self.bytes += size;
    }
}
pub(super) fn get(text: &str, compute: impl FnOnce(&str) -> Vec<String>) -> Vec<String> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let cache = CACHE.get_or_init(Mutex::default);
    if let Ok(guard) = cache.lock() {
        if let Some(chunks) = guard.find(text) {
            return chunks;
        }
    }
    let chunks = compute(text);
    if let Ok(mut guard) = cache.lock() {
        guard.insert(text, &chunks, LIMIT);
    }
    chunks
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_bytes_only_and_bounded_eviction() {
        let mut cache = Cache::default();
        cache.insert("abc", &["abc".into()], 10);
        assert_eq!(cache.find("abc"), Some(vec!["abc".into()]));
        assert!(cache.find("abcd").is_none());
        cache.insert("def", &["def".into()], 10);
        assert!(cache.find("abc").is_none());
        assert!(cache.bytes <= 10);
        cache.insert("oversized input", &["oversized output".into()], 10);
        assert!(cache.find("oversized input").is_none());
    }
    #[test]
    fn cached_chunks_equal_uncached_for_unicode_and_changed_metadata() {
        for source in [
            "---\ntitle: 한글\n---\n**User:**\n완료 아님",
            "---\ntitle: 수정\n---\n**User:**\n완료 아님",
            "# e\u{301}\n수정된 원문",
        ] {
            let expected = super::super::chunk_page_uncached(source);
            assert_eq!(get(source, super::super::chunk_page_uncached), expected);
            assert_eq!(
                get(source, |_| panic!("unchanged bytes should reuse chunks")),
                expected
            );
        }
    }
}
