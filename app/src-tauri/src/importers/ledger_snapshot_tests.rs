use super::*;

#[test]
fn checked_snapshot_preserves_old_index_without_backfill_or_vault_binding() {
    let bytes = br#"{"entries":{"codex:prior":"prior"},"locations":{"sessions:codex:prior":"sessions/prior.md"}}"#;
    let ledger = Ledger::parse_checked_snapshot(bytes).unwrap();
    assert!(ledger.seen("codex:prior", "prior"));
    assert_eq!(
        ledger.location("sessions", "codex:prior"),
        Some("sessions/prior.md")
    );
    assert_eq!(ledger.body_index_version(), 0);
    assert_eq!(ledger.bodies_indexed(), 0);
    assert_eq!(ledger.absorbed(), 0);
    assert!(ledger.loaded_path.is_none());
    let revision = crate::importers::wikify::source_revision(std::str::from_utf8(bytes).unwrap());
    assert_eq!(ledger.expected_revision.as_deref(), Some(revision.as_str()));
}

#[test]
fn checked_snapshot_preserves_complete_known_fields() {
    let bytes = br#"{"entries":{"codex:prior":"prior"},"files":{"/synthetic/session.jsonl":{"mtime_ns":12,"len":34,"convs":2,"parser_version":3}},"bodies":{"body":"codex:prior"},"duplicates":7,"body_index_version":1,"absorbed":5,"locations":{"sessions:codex:prior":"sessions/prior.md"}}"#;
    let ledger = Ledger::parse_checked_snapshot(bytes).unwrap();
    assert!(ledger.seen("codex:prior", "prior"));
    assert_eq!(
        ledger.file_convs("/synthetic/session.jsonl", 12, 34),
        Some(2)
    );
    assert!(ledger.seen_body("body", "codex:other"));
    assert!(!ledger.seen_body("body", "codex:prior"));
    assert_eq!(ledger.duplicates(), 7);
    assert_eq!(ledger.body_index_version(), BODY_INDEX_VERSION);
    assert_eq!(ledger.absorbed(), 5);
    assert_eq!(
        ledger.location("sessions", "codex:prior"),
        Some("sessions/prior.md")
    );
}

#[test]
fn checked_snapshot_retains_legacy_flat_map_and_existing_version_semantics() {
    let legacy =
        Ledger::parse_checked_snapshot(br#"{"codex:prior":"prior","chatgpt:other":"other"}"#)
            .unwrap();
    assert!(legacy.seen("codex:prior", "prior"));
    assert!(legacy.seen("chatgpt:other", "other"));
    assert_eq!(legacy.body_index_version(), 0);
    assert_eq!(legacy.bodies_indexed(), 0);

    // Parsing preserves the existing decoder's version field; it does not
    // establish support for consuming a future version as lineage authority.
    let future =
        Ledger::parse_checked_snapshot(br#"{"entries":{},"body_index_version":9}"#).unwrap();
    assert_eq!(future.body_index_version(), 9);
}

#[test]
fn checked_snapshot_rejects_invalid_bytes_and_unknown_structured_fields() {
    for bytes in [
        b"".as_slice(),
        b"{broken".as_slice(),
        b"null".as_slice(),
        b"true".as_slice(),
        b"{\"entries\":[]}".as_slice(),
        b"{\"entries\":{},\"future_state\":{\"revision\":2}}".as_slice(),
        b"{\"entries\":{\"codex:prior\":\"\xff\"}}".as_slice(),
    ] {
        assert!(Ledger::parse_checked_snapshot(bytes).is_err());
    }
}
