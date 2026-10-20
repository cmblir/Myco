use super::*;
use sha2::{Digest, Sha256};

fn anchor_fixture() -> (VectorStore, Ontology, String, Vec<f32>) {
    let store = super::tests::six_pages();
    let baseline = build(&store, &[], &[]).unwrap();
    let label = baseline.clusters[0].label.clone();
    let mut vector = vec![0.1, 0.2, 0.97];
    normalize_output(&mut vector, Some(3)).unwrap();
    (store, baseline, label, vector)
}

fn chosen_member_similarities(store: &VectorStore, cluster: &Cluster) -> Vec<(String, f32)> {
    let centroids = store.page_centroids().unwrap();
    let mut ranked: Vec<_> = cluster
        .members
        .iter()
        .map(|page| {
            let vector = &centroids.iter().find(|(name, _)| name == page).unwrap().1;
            (
                page.clone(),
                checked_cosine(vector, &cluster.centroid).unwrap(),
            )
        })
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked
}

fn close(actual: f32, expected: f64) {
    assert!(
        (f64::from(actual) - expected).abs() <= 1e-6,
        "chosen reference geometry: actual {actual}, expected {expected}"
    );
}

#[test]
fn anchor_mean_and_deviation_describe_the_chosen_reference() {
    let (store, _baseline, label, vector) = anchor_fixture();
    let anchored = build(&store, &[], &[(label.clone(), vector)]).unwrap();
    let cluster = anchored.clusters.iter().find(|c| c.label == label).unwrap();
    let scores = chosen_member_similarities(&store, cluster);
    let mean = scores
        .iter()
        .map(|(_, score)| f64::from(*score))
        .sum::<f64>()
        / scores.len() as f64;
    let deviation = (scores
        .iter()
        .map(|(_, score)| (f64::from(*score) - mean).powi(2))
        .sum::<f64>()
        / scores.len() as f64)
        .sqrt();
    close(cluster.sim_mean, mean);
    close(cluster.sim_std, deviation);
}

#[test]
fn anchor_percentiles_describe_the_chosen_reference() {
    let (store, _baseline, label, vector) = anchor_fixture();
    let anchored = build(&store, &[], &[(label.clone(), vector)]).unwrap();
    let cluster = anchored.clusters.iter().find(|c| c.label == label).unwrap();
    let mut scores: Vec<_> = chosen_member_similarities(&store, cluster)
        .into_iter()
        .map(|(_, score)| score)
        .collect();
    scores.sort_by(f32::total_cmp);
    assert_eq!(scores.len(), 3);
    close(cluster.p5, f64::from(scores[0]));
    close(cluster.p25, f64::from(scores[1]));
    close(cluster.p40, f64::from(scores[1]));
}

#[test]
fn anchor_nearest_members_follow_the_chosen_reference() {
    let (store, _baseline, label, vector) = anchor_fixture();
    let anchored = build(&store, &[], &[(label.clone(), vector)]).unwrap();
    let cluster = anchored.clusters.iter().find(|c| c.label == label).unwrap();
    let expected: Vec<_> = chosen_member_similarities(&store, cluster)
        .into_iter()
        .map(|(page, _)| page)
        .collect();
    assert_eq!(cluster.members, expected);
}

#[test]
fn anchor_nonunit_reference_keeps_valid_cosine_statistics() {
    let (store, _baseline, label, vector) = anchor_fixture();
    let vector: Vec<_> = vector.into_iter().map(|value| value * 100.0).collect();
    let anchored = build(&store, &[], &[(label.clone(), vector.clone())]).unwrap();
    let cluster = anchored.clusters.iter().find(|c| c.label == label).unwrap();
    assert_eq!(cluster.centroid, vector);
    anchored.validate_geometry(Some(3)).unwrap();
    let scores = chosen_member_similarities(&store, cluster);
    close(
        cluster.sim_mean,
        scores
            .iter()
            .map(|(_, score)| f64::from(*score))
            .sum::<f64>()
            / scores.len() as f64,
    );
}

#[test]
fn anchor_member_can_be_admitted_using_its_actual_reference_distribution() {
    let (store, _baseline, label, vector) = anchor_fixture();
    let anchored = build(&store, &[], &[(label.clone(), vector)]).unwrap();
    let cluster = anchored.clusters.iter().find(|c| c.label == label).unwrap();
    let member = chosen_member_similarities(&store, cluster)[0].0.clone();
    let cents = store.page_centroids().unwrap();
    let member_vector = &cents.iter().find(|(page, _)| page == &member).unwrap().1;
    let verdict = admit(&anchored, member_vector, "", &GatePreset::Normal, &[]).unwrap();
    assert_eq!(verdict.nearest_cluster, label);
    assert_eq!(verdict.tier, Tier::Full);
}

#[test]
fn anchor_does_not_change_an_unmatched_cluster() {
    let (store, baseline, label, vector) = anchor_fixture();
    let anchored = build(&store, &[], &[(label.clone(), vector)]).unwrap();
    let before = baseline.clusters.iter().find(|c| c.label != label).unwrap();
    let after = anchored.clusters.iter().find(|c| c.label != label).unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(after).unwrap()
    );
}

#[test]
fn anchor_with_no_matching_member_keeps_every_cluster_unchanged() {
    let (store, baseline, _label, vector) = anchor_fixture();
    let anchored = build(&store, &[], &[("unmatched-topic".into(), vector)]).unwrap();
    assert_eq!(
        serde_json::to_value(baseline.clusters).unwrap(),
        serde_json::to_value(anchored.clusters).unwrap()
    );
}

#[test]
fn anchor_old_geometry_policy_cache_is_not_current_after_the_policy_repair() {
    let (mut store, _baseline, label, vector) = anchor_fixture();
    store.model = "synthetic-model".into();
    store.signature = "synthetic-representation".into();
    let anchors = vec![(label, vector)];
    let mut legacy = build(&store, &[], &anchors).unwrap();
    let legacy_inputs = serde_json::to_vec(&(
        "ontology-source-v1",
        LABEL_PROP_SWEEPS,
        CLUSTER_KNN_K,
        &store,
        &[] as &[(String, String)],
        &anchors,
    ))
    .unwrap();
    legacy.source_signature = format!("{:x}", Sha256::digest(legacy_inputs));
    let directory = tempfile::tempdir().unwrap();
    save(directory.path(), &legacy).unwrap();
    let path = crate::vault_dir::dir(directory.path()).join("ontology.json");
    let before = std::fs::read(&path).unwrap();
    assert!(load_for_store(directory.path(), &store, &[], &anchors)
        .unwrap()
        .is_none());
    assert_eq!(std::fs::read(path).unwrap(), before);
}
