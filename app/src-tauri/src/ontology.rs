//! Ontology cache + admission gate (Phase A, Task 3).
//!
//! The ontology is a derived snapshot of the wiki's topic structure: clusters
//! of pages found by label propagation over the semantic kNN graph
//! (`vector_index::centroid_edges`), each with a similarity distribution used
//! to decide whether a new item belongs (`admit`). It persists to
//! `<vault>/.myco/ontology.json`, same atomic tmp+rename pattern as
//! `distill::config_save`, and is invalidated on an embedding-model change
//! (`load`'s model check) the same way the vector index itself is.

use std::path::Path;

use crate::distill::GatePreset;
use crate::embeddings::{cosine, normalize};
use crate::vector_index::VectorStore;

/// One topic cluster. `members` is ordered by cosine-to-`centroid` descending
/// — the ontology cache holds no per-member vectors (only the cluster
/// centroid), so this build-time ordering doubles as both the medoid pick
/// (`members[0]`, whose stem becomes `label`) and the "most representative
/// pages" list `admit` hands back as `nearest_pages`.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Cluster {
    pub id: u32,
    pub label: String,
    pub members: Vec<String>,
    pub centroid: Vec<f32>,
    pub sim_mean: f32,
    pub sim_std: f32,
    pub p5: f32,
    pub p25: f32,
    pub p40: f32,
    pub last_touched: i64,
    /// 0.0 by default; a per-cluster radius widening Task 8's UI may raise
    /// when the user overrides this cluster's verdicts often.
    pub override_widen: f32,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Ontology {
    pub model: String,
    pub built_at: i64,
    pub wiki_pages: usize,
    pub clusters: Vec<Cluster>,
    /// Lowercase stems + frontmatter titles, for whole-word matching against
    /// incoming item text.
    pub entities: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Full,
    Summary,
    Quarantine,
    Reject,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Verdict {
    pub tier: Tier,
    pub s_knn: f32,
    pub nearest_cluster: String,
    pub nearest_pages: Vec<String>,
    pub entity_hits: Vec<String>,
    pub reason: String,
}

/// Cluster whose members never earned a group of their own (label propagation
/// converged on fewer than 3 members) — a catch-all "misc" bucket. Never
/// grants `Tier::Full`; `admit` checks this id explicitly. `pub(crate)`: Phase
/// B's map-candidate pass (`distill::propose_map_candidates`) checks it too —
/// the catch-all bucket is not a real topic and must never get a topic map.
pub(crate) const FIELD_CLUSTER_ID: u32 = u32::MAX;

/// Sweeps of label propagation. Fixed rather than "until convergence" so
/// `build` has a bounded cost on a large vault; the synthetic and real-vault
/// geometries measured so far settle in 2-3 sweeps.
const LABEL_PROP_SWEEPS: usize = 10;

/// How many nearest neighbours the cluster graph is built from. Matches the
/// brief's calibration: sparse enough on a real vault to be a real kNN graph,
/// dense enough that a handful of pages still forms one connected component.
const CLUSTER_KNN_K: usize = 6;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn stem_of(page: &str) -> String {
    let name = page.rsplit('/').next().unwrap_or(page);
    name.strip_suffix(".md").unwrap_or(name).to_string()
}

/// Mean of the given vectors, renormalized to unit length — same idiom as
/// `VectorStore::page_centroids`, applied one level up (pages -> cluster).
fn mean_renorm(vecs: &[&Vec<f32>]) -> Vec<f32> {
    let Some(dim) = vecs.first().map(|v| v.len()) else {
        return Vec::new();
    };
    let mut out = vec![0f32; dim];
    for v in vecs {
        for (i, x) in v.iter().enumerate().take(dim) {
            out[i] += x;
        }
    }
    for x in out.iter_mut() {
        *x /= vecs.len() as f32;
    }
    normalize(&mut out);
    out
}

/// Nearest-rank percentile of an ASCENDING-sorted slice, `p` in `[0, 100]`.
fn percentile(sorted_ascending: &[f32], p: f32) -> f32 {
    let Some(&last_val) = sorted_ascending.last() else {
        return 0.0;
    };
    let last = sorted_ascending.len() - 1;
    if last == 0 {
        return last_val;
    }
    let idx = ((p / 100.0) * last as f32).round() as usize;
    sorted_ascending[idx.min(last)]
}

/// Build one cluster from its member page names. `force_label` overrides the
/// medoid-stem label for the synthetic "field" cluster.
fn assemble_cluster(
    id: u32,
    member_names: Vec<String>,
    cent_map: &std::collections::HashMap<&str, &Vec<f32>>,
    force_label: Option<&str>,
) -> Cluster {
    let vecs: Vec<&Vec<f32>> = member_names
        .iter()
        .filter_map(|m| cent_map.get(m.as_str()).copied())
        .collect();
    let centroid = mean_renorm(&vecs);
    let mut scored: Vec<(String, f32)> = member_names
        .iter()
        .filter_map(|m| {
            cent_map
                .get(m.as_str())
                .map(|v| (m.clone(), cosine(v, &centroid)))
        })
        .collect();
    // Descending similarity to the cluster's own centroid; ties broken by page
    // name so the order (and therefore the medoid pick) is deterministic.
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    let members: Vec<String> = scored.iter().map(|(m, _)| m.clone()).collect();
    let mut sims: Vec<f32> = scored.iter().map(|(_, s)| *s).collect();
    let n = sims.len().max(1) as f32;
    let sim_mean = sims.iter().sum::<f32>() / n;
    let variance = sims.iter().map(|s| (s - sim_mean).powi(2)).sum::<f32>() / n;
    sims.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let label = match force_label {
        Some(l) => l.to_string(),
        None => stem_of(members.first().map(String::as_str).unwrap_or("")),
    };
    Cluster {
        id,
        label,
        members,
        centroid,
        sim_mean,
        sim_std: variance.sqrt(),
        p5: percentile(&sims, 5.0),
        p25: percentile(&sims, 25.0),
        p40: percentile(&sims, 40.0),
        last_touched: 0, // filled by `stamp_last_touched`, which needs a vault root
        override_widen: 0.0,
    }
}

/// Cluster the wiki's semantic graph and compute per-cluster admission stats.
///
/// Deterministic: node order comes from the sorted page list, every sweep
/// visits nodes in that same fixed order, and every tie (propagation, member
/// ranking, cluster ordering) breaks on page name.
///
/// Weighted, not a plain vote count: `centroid_edges(k)` is a genuine kNN
/// graph on a real vault, but on a small/synthetic one (or any vault with
/// <= k+1 pages) it degenerates to a complete graph, where an unweighted
/// majority vote converges to a single global label regardless of geometry.
/// Weighting each neighbour's vote by its edge score (cosine) is what lets two
/// well-separated blobs actually stay separate.
///
/// Updates are asynchronous (in place, so a node can see a neighbour's
/// brand-new label within the same sweep) rather than computed from a frozen
/// snapshot: synchronous updates on this complete-graph case oscillate —
/// each of the three tightly-clustered members' pairwise similarities differs
/// only in noise-level jitter, so "my single best-scoring neighbour" keeps
/// rotating between them sweep to sweep instead of ever settling. Letting
/// each update see its predecessors' results turns that into a fast-growing
/// majority within one pass.
///
/// `map_anchors` (Phase B, Task 4) is `(cluster label, page centroid)` for
/// every `wiki/maps/` page the caller found on disk — once a cluster has a
/// human-approved topic map, that page's own centroid replaces the cluster's
/// geometric mean as the `admit` reference point (see the anchor-substitution
/// loop below). Callers with no maps yet (including every test below) pass
/// `&[]`.
pub fn build(
    store: &VectorStore,
    wiki_titles: &[(String, String)],
    map_anchors: &[(String, Vec<f32>)],
) -> Ontology {
    let cents = store.page_centroids();
    let cent_map: std::collections::HashMap<&str, &Vec<f32>> =
        cents.iter().map(|(p, v)| (p.as_str(), v)).collect();
    let edges = store.centroid_edges(CLUSTER_KNN_K);

    // Node set = pages that survive `centroid_edges`' machine-written filter,
    // reusing that filter here (rather than re-implementing it) so the
    // cluster graph agrees with "which pages get suggested" elsewhere.
    let nodes: Vec<String> = {
        let mut set = std::collections::BTreeSet::new();
        for e in &edges {
            set.insert(e.a.clone());
            set.insert(e.b.clone());
        }
        set.into_iter().collect()
    };
    let idx_of: std::collections::HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.as_str(), i))
        .collect();

    let mut adj: Vec<Vec<(usize, f32)>> = vec![Vec::new(); nodes.len()];
    for e in &edges {
        if let (Some(&i), Some(&j)) = (idx_of.get(e.a.as_str()), idx_of.get(e.b.as_str())) {
            adj[i].push((j, e.score));
            adj[j].push((i, e.score));
        }
    }

    // Init: each node its own label, in sorted-page order.
    let mut labels: Vec<usize> = (0..nodes.len()).collect();
    for _ in 0..LABEL_PROP_SWEEPS {
        let mut changed = false;
        for i in 0..nodes.len() {
            let neighbours = &adj[i];
            if neighbours.is_empty() {
                continue; // isolated node keeps its own label
            }
            let mut weight_by_label: std::collections::HashMap<usize, f32> =
                std::collections::HashMap::new();
            for &(j, w) in neighbours {
                *weight_by_label.entry(labels[j]).or_insert(0.0) += w;
            }
            // Ascending by label before comparing weights: a strict `>` only
            // replaces the best on a STRICTLY higher score, so among equal-
            // weight ties the smallest label (seen first) wins.
            let mut ranked: Vec<(usize, f32)> = weight_by_label.into_iter().collect();
            ranked.sort_by_key(|&(lab, _)| lab);
            let mut best = (labels[i], f32::MIN);
            for (lab, w) in ranked {
                if w > best.1 {
                    best = (lab, w);
                }
            }
            if best.0 != labels[i] {
                changed = true;
                labels[i] = best.0;
            }
        }
        if !changed {
            break; // converged
        }
    }

    let mut groups: std::collections::HashMap<usize, Vec<String>> =
        std::collections::HashMap::new();
    for (page, &lab) in nodes.iter().zip(labels.iter()) {
        groups.entry(lab).or_default().push(page.clone());
    }
    let mut big: Vec<Vec<String>> = Vec::new();
    let mut small: Vec<String> = Vec::new();
    for members in groups.into_values() {
        if members.len() >= 3 {
            big.push(members);
        } else {
            small.extend(members);
        }
    }
    // Deterministic cluster order/ids: by the group's own smallest page name,
    // independent of the arbitrary integer labels propagation happened to land on.
    big.sort_by(|a, b| a.iter().min().cmp(&b.iter().min()));

    let mut clusters: Vec<Cluster> = big
        .into_iter()
        .enumerate()
        .map(|(id, members)| assemble_cluster(id as u32, members, &cent_map, None))
        .collect();
    if !small.is_empty() {
        clusters.push(assemble_cluster(
            FIELD_CLUSTER_ID,
            small,
            &cent_map,
            Some("field"),
        ));
    }

    // Human-approved topic-map centroid > mean-of-members: a human confirmed
    // what this cluster is about by approving its map, which is a better
    // `admit` reference point than an unsupervised average of its members
    // (design spec, "topic maps"). Only clusters an anchor's label actually
    // names are touched; every other cluster keeps its computed centroid.
    for c in &mut clusters {
        if let Some((_, anchor)) = map_anchors.iter().find(|(label, _)| label == &c.label) {
            c.centroid = anchor.clone();
        }
    }

    let mut entities: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (stem, title) in wiki_titles {
        let s = stem.trim().to_lowercase();
        if !s.is_empty() {
            entities.insert(s);
        }
        let t = title.trim().to_lowercase();
        if !t.is_empty() {
            entities.insert(t);
        }
    }

    Ontology {
        model: store.model.clone(),
        built_at: now_secs(),
        // The full wiki page count, not `nodes.len()` (pages that survived
        // `centroid_edges`' filter) — `distill::run`'s staleness check
        // compares this against `commands::wiki_titles(root).len()`, the
        // same real disk count, so the two must be the same quantity or a
        // rebuild triggers every run even when nothing changed.
        wiki_pages: wiki_titles.len(),
        clusters,
        entities: entities.into_iter().collect(),
    }
}

/// Read the cached ontology, or `None` if there is none yet or it was built
/// against a different embedding model (the same invalidation rule as the
/// vector index itself: a model change means incompatible vector geometry).
pub fn load(root: &Path, model: &str) -> Option<Ontology> {
    let path = crate::vault_dir::dir(root).join("ontology.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let o: Ontology = serde_json::from_str(&raw).ok()?;
    if o.model != model {
        return None;
    }
    Some(o)
}

/// Atomic write: stage to a temp file in the same dir, then rename over
/// target — same pattern as `distill::config_save`.
pub fn save(root: &Path, o: &Ontology) -> Result<(), String> {
    let dir = crate::vault_dir::dir(root);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create {} dir: {e}", crate::vault_dir::DIR_NAME))?;
    let raw = serde_json::to_string_pretty(o).map_err(|e| format!("serialize: {e}"))?;
    let target = dir.join("ontology.json");
    let tmp = dir.join(".ontology.json.tmp");
    std::fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Fill each cluster's `last_touched` from its member pages' file mtimes,
/// skipping any member whose file is missing. Kept out of `build` on purpose:
/// `build` takes a bare `VectorStore` (the unit tests below construct one with
/// no files on disk at all), while this needs a real vault root — the Tauri
/// command layer has one and calls this right after `build`.
pub fn stamp_last_touched(root: &Path, o: &mut Ontology) {
    for c in &mut o.clusters {
        let mut latest = 0i64;
        for m in &c.members {
            let Ok(meta) = std::fs::metadata(root.join(m)) else {
                continue;
            };
            let Ok(modified) = meta.modified() else {
                continue;
            };
            let secs = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            latest = latest.max(secs);
        }
        c.last_touched = latest;
    }
}

/// `needle` appears in `haystack` bounded by non-alphanumeric characters (or a
/// string edge) on both sides — a whole-word/phrase match without pulling in
/// a regex dependency for what is, at most, a handful of short lowercase
/// entity strings per call.
fn contains_whole_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let is_word = |c: char| c.is_alphanumeric();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        let abs = start + pos;
        let before_ok = haystack[..abs]
            .chars()
            .next_back()
            .map(|c| !is_word(c))
            .unwrap_or(true);
        let after = abs + needle.len();
        let after_ok = haystack[after..]
            .chars()
            .next()
            .map(|c| !is_word(c))
            .unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
        start = abs + 1;
        if start >= haystack.len() {
            break;
        }
    }
    false
}

fn matched_entities(o: &Ontology, item_text_lower: &str) -> Vec<String> {
    o.entities
        .iter()
        .filter(|e| contains_whole_word(item_text_lower, e))
        .cloned()
        .collect()
}

/// Strict/Loose ask for p10/p1 thresholds, but only p5/p25/p40 are persisted
/// per cluster (the calibration follow-up in Task 1's spec needs exactly
/// those three). Approximate the others by extending the local slope between
/// the two nearest stored anchors.
///
/// ponytail: linear extrapolation, not a measured percentile — upgrade path is
/// storing the full member-similarity distribution (or all five percentiles)
/// per cluster if Strict/Loose ever need to be exact rather than approximate.
fn threshold_at(c: &Cluster, target_pct: f32) -> f32 {
    let anchors = [(5.0f32, c.p5), (25.0, c.p25), (40.0, c.p40)];
    if target_pct <= anchors[0].0 {
        let slope = (anchors[1].1 - anchors[0].1) / (anchors[1].0 - anchors[0].0);
        return anchors[0].1 + slope * (target_pct - anchors[0].0);
    }
    if target_pct >= anchors[2].0 {
        let slope = (anchors[2].1 - anchors[1].1) / (anchors[2].0 - anchors[1].0);
        return anchors[2].1 + slope * (target_pct - anchors[2].0);
    }
    for w in anchors.windows(2) {
        let (x0, y0) = w[0];
        let (x1, y1) = w[1];
        if target_pct >= x0 && target_pct <= x1 {
            let t = (target_pct - x0) / (x1 - x0);
            return y0 + t * (y1 - y0);
        }
    }
    c.p25 // unreachable given the anchor list above
}

/// Names the threshold that actually decided `natural_tier` — the `s_knn`-only
/// verdict, before any entity-floor lift — so Reject/Quarantine cite `t_quar`,
/// Summary cites the midpoint band, and Full cites `t_full`. An entity-floor
/// lift is called out explicitly rather than silently reported as if `s_knn`
/// had cleared the summary band on its own.
#[allow(clippy::too_many_arguments)]
fn describe(
    natural_tier: Tier,
    entity_lifted: bool,
    label: &str,
    s_knn: f32,
    t_full: f32,
    full_pct: f32,
    t_summary: f32,
    t_quar: f32,
    quar_pct: f32,
    entity_count: usize,
) -> String {
    let threshold_clause = match natural_tier {
        Tier::Full => format!("similarity {s_knn:.2} >= admission {t_full:.2} (p{full_pct:.0})"),
        Tier::Summary => format!(
            "similarity {s_knn:.2} >= summary {t_summary:.2} (midpoint p{quar_pct:.0}..p{full_pct:.0})"
        ),
        Tier::Quarantine => {
            format!("similarity {s_knn:.2} >= quarantine {t_quar:.2} (p{quar_pct:.0})")
        }
        Tier::Reject => format!("similarity {s_knn:.2} < quarantine {t_quar:.2} (p{quar_pct:.0})"),
    };
    let verdict = if entity_lifted {
        "summary (entity floor)"
    } else {
        match natural_tier {
            Tier::Full => "full admission",
            Tier::Summary => "summary only",
            Tier::Quarantine => "quarantine",
            Tier::Reject => "reject",
        }
    };
    let entity_word = if entity_count == 1 {
        "entity"
    } else {
        "entities"
    };
    format!("nearest topic '{label}' {threshold_clause} -> {verdict}; {entity_count} known {entity_word}")
}

/// Decision tree (see `app/docs/specs/2026-08-13-ontology-distill-design.md`):
/// an entity floor of >= 2 known entities lifts an otherwise Reject/Quarantine
/// item to at least Summary; above that, `s_knn` (cosine to the nearest
/// cluster's centroid) against that cluster's own calibrated thresholds picks
/// Full / Summary / Quarantine / Reject. The synthetic "field" cluster
/// (`FIELD_CLUSTER_ID`) can grant Summary/Quarantine/Reject but never Full.
pub fn admit(o: &Ontology, item_vec: &[f32], item_text: &str, preset: &GatePreset) -> Verdict {
    let item_text_lower = item_text.to_lowercase();
    let entity_hits = matched_entities(o, &item_text_lower);

    let nearest = o
        .clusters
        .iter()
        .map(|c| (c, cosine(item_vec, &c.centroid)))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let Some((cluster, s_knn)) = nearest else {
        return Verdict {
            tier: Tier::Reject,
            s_knn: 0.0,
            nearest_cluster: String::new(),
            nearest_pages: Vec::new(),
            entity_hits,
            reason: "no ontology yet — vault has not been distilled".into(),
        };
    };

    let (full_pct, quar_pct) = match preset {
        GatePreset::Strict => (40.0, 10.0),
        GatePreset::Normal => (25.0, 5.0),
        GatePreset::Loose => (10.0, 1.0),
    };
    let t_full = threshold_at(cluster, full_pct) - cluster.override_widen;
    let t_quar = threshold_at(cluster, quar_pct) - cluster.override_widen;
    let t_summary = (t_full + t_quar) / 2.0;
    let is_field = cluster.id == FIELD_CLUSTER_ID;

    let natural_tier = if s_knn >= t_full && !is_field {
        Tier::Full
    } else if s_knn >= t_summary {
        Tier::Summary
    } else if s_knn >= t_quar {
        Tier::Quarantine
    } else {
        Tier::Reject
    };
    let entity_lifted =
        entity_hits.len() >= 2 && matches!(natural_tier, Tier::Reject | Tier::Quarantine);
    let tier = if entity_lifted {
        Tier::Summary
    } else {
        natural_tier
    };

    let nearest_pages = cluster.members.iter().take(3).cloned().collect();
    let reason = describe(
        natural_tier,
        entity_lifted,
        &cluster.label,
        s_knn,
        t_full,
        full_pct,
        t_summary,
        t_quar,
        quar_pct,
        entity_hits.len(),
    );
    Verdict {
        tier,
        s_knn,
        nearest_cluster: cluster.label.clone(),
        nearest_pages,
        entity_hits,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vector_index::Record;

    fn unit(v: Vec<f32>) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / n).collect()
    }

    fn store_with(pages: &[(&str, Vec<f32>)]) -> VectorStore {
        let mut s = VectorStore::default();
        for (page, v) in pages {
            if s.dim == 0 {
                s.dim = v.len();
            }
            s.records.push(Record {
                id: format!("{page}#0"),
                page: page.to_string(),
                stem: stem_of(page),
                section: 0,
                hash: 0,
                vector: v.clone(),
            });
        }
        s
    }

    fn six_pages() -> VectorStore {
        store_with(&[
            ("wiki/a.md", unit(vec![1.0, 0.05, 0.0])),
            ("wiki/b.md", unit(vec![1.0, -0.02, 0.03])),
            ("wiki/c.md", unit(vec![0.98, 0.0, 0.05])),
            ("wiki/x.md", unit(vec![0.02, 1.0, 0.0])),
            ("wiki/y.md", unit(vec![0.0, 0.97, 0.04])),
            ("wiki/z.md", unit(vec![-0.03, 1.0, 0.0])),
        ])
    }

    #[test]
    fn label_propagation_finds_two_blobs() {
        // 6 pages: 3 near +x axis, 3 near +y axis -> exactly 2 clusters
        let s = six_pages();
        let o = build(&s, &[], &[]);
        assert_eq!(o.clusters.len(), 2);
        assert!(o.clusters.iter().all(|c| c.members.len() == 3));
    }

    #[test]
    fn admit_tiers_follow_the_decision_tree() {
        let s = six_pages();
        let o = build(
            &s,
            &[
                ("a".into(), "Alpha Topic".into()),
                ("b".into(), "Beta".into()),
            ],
            &[],
        );
        let p = GatePreset::Normal;
        // In-cluster item -> Full; the reason cites the threshold that
        // actually decided it (t_full == the winning cluster's p25, since
        // GatePreset::Normal picks that anchor exactly).
        let vf = admit(&o, &unit(vec![1.0, 0.01, 0.0]), "", &p);
        assert!(matches!(vf.tier, Tier::Full));
        let full_cluster = o
            .clusters
            .iter()
            .find(|c| c.label == vf.nearest_cluster)
            .unwrap();
        assert!(
            vf.reason.contains(&format!("{:.2}", full_cluster.p25)),
            "reason: {}",
            vf.reason
        );
        // Orthogonal item -> Reject, and the reason names the nearest cluster,
        // and cites t_quar (== the cluster's p5) — the threshold it failed.
        let v = admit(&o, &unit(vec![0.0, 0.0, 1.0]), "", &p);
        assert!(matches!(v.tier, Tier::Reject));
        assert!(v.reason.contains(&v.nearest_cluster));
        let reject_cluster = o
            .clusters
            .iter()
            .find(|c| c.label == v.nearest_cluster)
            .unwrap();
        assert!(
            v.reason.contains(&format!("{:.2}", reject_cluster.p5)),
            "reason: {}",
            v.reason
        );
        // Two known entities lift an otherwise-rejected item to at least Summary
        let v2 = admit(
            &o,
            &unit(vec![0.0, 0.0, 1.0]),
            "discussing Alpha Topic and Beta today",
            &p,
        );
        assert!(!matches!(v2.tier, Tier::Reject) && !matches!(v2.tier, Tier::Quarantine));
        assert_eq!(v2.entity_hits.len(), 2);
        // The lift is called out explicitly rather than reported as if s_knn
        // alone had cleared the summary band.
        assert!(v2.reason.contains("entity floor"), "reason: {}", v2.reason);
    }

    /// Hand-built ontology with clean, well-separated thresholds (p5=0.10,
    /// p25=0.50, p40=0.90) so each of the four tiers is hit by construction,
    /// rather than fought for in real geometry — a tight cluster's percentiles
    /// bunch up within a hundredth of 1.0, making it impractical to land an
    /// item exactly in a given band on purpose.
    #[test]
    fn admit_reason_cites_the_threshold_that_actually_decided_the_tier() {
        let cluster = Cluster {
            id: 0,
            label: "topicx".into(),
            members: vec!["wiki/topicx.md".into()],
            centroid: vec![1.0, 0.0],
            sim_mean: 0.9,
            sim_std: 0.1,
            p5: 0.10,
            p25: 0.50,
            p40: 0.90,
            last_touched: 0,
            override_widen: 0.0,
        };
        let o = Ontology {
            model: "m".into(),
            built_at: 0,
            wiki_pages: 1,
            clusters: vec![cluster],
            entities: Vec::new(),
        };
        let p = GatePreset::Normal; // t_full=p25=0.50, t_quar=p5=0.10, t_summary=midpoint=0.30
                                    // A unit vector at cosine `cos` from the centroid [1, 0].
        let at = |cos: f32| vec![cos, (1.0 - cos * cos).sqrt()];

        let full = admit(&o, &at(0.90), "", &p);
        assert!(matches!(full.tier, Tier::Full));
        assert!(full.reason.contains("0.50"), "reason: {}", full.reason);

        let summary = admit(&o, &at(0.35), "", &p);
        assert!(matches!(summary.tier, Tier::Summary));
        assert!(
            summary.reason.contains("midpoint"),
            "reason: {}",
            summary.reason
        );

        let quarantine = admit(&o, &at(0.15), "", &p);
        assert!(matches!(quarantine.tier, Tier::Quarantine));
        assert!(
            quarantine.reason.contains("0.10"),
            "reason: {}",
            quarantine.reason
        );

        let reject = admit(&o, &at(0.05), "", &p);
        assert!(matches!(reject.tier, Tier::Reject));
        assert!(reject.reason.contains("0.10"), "reason: {}", reject.reason);
    }

    #[test]
    fn map_anchor_replaces_cluster_centroid() {
        let s = six_pages();
        let plain = build(&s, &[], &[]);
        let target_label = plain.clusters[0].label.clone();
        let other_centroid_before = plain.clusters[1].centroid.clone();
        // Deliberately far from the natural mean, so a passing assertion can
        // only mean the anchor was actually substituted, not coincidence.
        let anchor = unit(vec![0.1, 0.2, 0.97]);

        let o = build(&s, &[], &[(target_label.clone(), anchor.clone())]);
        let target = o.clusters.iter().find(|c| c.label == target_label).unwrap();
        assert_eq!(target.centroid, anchor);
        // The other cluster names no anchor — its centroid is untouched.
        let other = o.clusters.iter().find(|c| c.label != target_label).unwrap();
        assert_eq!(other.centroid, other_centroid_before);
    }

    #[test]
    fn model_mismatch_invalidates_cache() {
        let dir = tempfile::tempdir().unwrap();
        let o = Ontology {
            model: "m1".into(),
            built_at: 0,
            wiki_pages: 0,
            clusters: Vec::new(),
            entities: Vec::new(),
        };
        save(dir.path(), &o).unwrap();
        assert!(load(dir.path(), "m1").is_some());
        assert!(load(dir.path(), "m2").is_none());
    }

    #[test]
    fn stamp_last_touched_uses_max_mtime_and_skips_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "a").unwrap();
        let mut o = Ontology {
            model: "m".into(),
            built_at: 0,
            wiki_pages: 1,
            entities: Vec::new(),
            clusters: vec![Cluster {
                id: 0,
                label: "a".into(),
                members: vec!["a.md".into(), "missing.md".into()],
                centroid: vec![1.0],
                sim_mean: 1.0,
                sim_std: 0.0,
                p5: 1.0,
                p25: 1.0,
                p40: 1.0,
                last_touched: 0,
                override_widen: 0.0,
            }],
        };
        stamp_last_touched(dir.path(), &mut o);
        assert!(o.clusters[0].last_touched > 0);
    }
}
