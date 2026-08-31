//! Unicode NFC normalization for every text comparison in the vault.
//!
//! macOS file APIs return Hangul filenames in NFD (decomposed jamo:
//! `"한글"` becomes `"한글"` at the codepoint level), while typed and
//! pasted text is NFC. The two forms are visually identical but compare
//! unequal, so without normalization an NFD-named page silently misses in
//! wikilink resolution, BM25 bigrams, substring search, and embeddings.
//!
//! One rule: every chokepoint that tokenizes, embeds, keys, or compares
//! vault text calls [`nfc`] first. The fast path (`is_nfc_quick`) makes the
//! overwhelmingly common already-NFC case a zero-copy check.

use std::borrow::Cow;
use unicode_normalization::{is_nfc_quick, IsNormalized, UnicodeNormalization};

/// Normalize to NFC, borrowing when the input already is (the common case).
pub fn nfc(s: &str) -> Cow<'_, str> {
    match is_nfc_quick(s.chars()) {
        IsNormalized::Yes => Cow::Borrowed(s),
        _ => Cow::Owned(s.nfc().collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_is_borrowed() {
        assert!(matches!(nfc("plain ascii"), Cow::Borrowed(_)));
    }

    #[test]
    fn nfc_hangul_is_borrowed() {
        assert!(matches!(nfc("한글 검색"), Cow::Borrowed(_)));
    }

    #[test]
    fn nfd_hangul_composes() {
        // "한글" decomposed into jamo, as macOS file APIs produce it.
        let nfd = "\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}";
        assert_eq!(nfc(nfd), "한글");
    }

    #[test]
    fn nfd_latin_accents_compose() {
        let nfd = "cafe\u{301}"; // e + combining acute
        assert_eq!(nfc(nfd), "café");
    }
}
