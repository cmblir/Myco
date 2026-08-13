// Does every consumer of raw/<slug>.md still resolve it at raw/archive/2026-08/<slug>.md?
// This decides whether Phase A may move files at all (spec Global Constraint).
use std::fs;

fn vault_with_cited_raw() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    fs::create_dir_all(r.join("raw/archive/2026-08")).unwrap();
    fs::create_dir_all(r.join("wiki")).unwrap();
    fs::write(
        r.join("wiki/topic.md"),
        "---\ntitle: Topic\ntype: concept\ncreated: 2026-01-01\nsource_count: 1\nconfidence: high\nstatus: active\n---\nClaim.[^src-paper]\n\n[^src-paper]: raw/paper.md\n",
    ).unwrap();
    d
}

#[test]
fn citation_resolves_when_raw_is_archived() {
    let d = vault_with_cited_raw();
    let r = d.path().canonicalize().unwrap();
    // The source lives in the archive, not raw/ root.
    fs::write(r.join("raw/archive/2026-08/paper.md"), "# Paper\ncontent").unwrap();
    let res = myco_lib::validator::validate_pages(&r, &["wiki/topic.md".into()]);
    assert!(
        res.errors.is_empty(),
        "citation to archived raw must not be a dangling-citation error: {:?}",
        res.errors
    );
}
