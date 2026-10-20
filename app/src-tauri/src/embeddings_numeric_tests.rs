//! Numeric admission regressions against the native production helpers.
use super::{combine_window_vectors, normalize};

fn norm_f64(vector: &[f32]) -> f64 {
    vector
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt()
}

#[test]
fn control_small_finite_vector_normalizes_to_unit_length() {
    let mut vector = [3.0f32, 4.0f32];
    normalize(&mut vector);
    let norm = norm_f64(&vector);
    println!("control output={vector:?}; f64 norm={norm}");
    assert!(
        (norm - 1.0).abs() < 1e-6,
        "finite ordinary vector must have unit norm: {vector:?}, norm={norm}"
    );
}

#[test]
fn finite_large_vector_must_not_collapse_to_zero_during_normalization() {
    let input = [f32::MAX / 4.0, f32::MAX / 4.0];
    assert!(input.iter().all(|value| value.is_finite()));
    assert!(norm_f64(&input).is_finite() && norm_f64(&input) > 0.0);
    let mut vector = input;
    normalize(&mut vector);
    let norm = norm_f64(&vector);
    println!(
        "large finite input={input:?}; copied normalize output={vector:?}; f64 output norm={norm}"
    );
    assert!(
        vector.iter().all(|value| value.is_finite()),
        "normalization output must remain finite"
    );
    assert!((norm - 1.0).abs() < 1e-6, "nonzero finite vector must retain unit L2 norm rather than collapse to zero: input={input:?}, output={vector:?}, f64_norm={norm}");
}

#[test]
fn single_zero_window_must_not_be_accepted_as_a_normalized_embedding() {
    let result = combine_window_vectors(&[vec![0.0f32, 0.0]], &[2]);
    println!("single zero window copied combine result={result:?}");
    assert!(
        result.is_err(),
        "zero-norm vector cannot satisfy the documented L2-normalized index contract: {result:?}"
    );
}

#[test]
fn all_zero_windows_must_not_be_accepted_as_a_normalized_embedding() {
    let result = combine_window_vectors(&[vec![0.0f32, 0.0], vec![0.0f32, 0.0]], &[2, 3]);
    println!("all zero windows copied combine result={result:?}");
    assert!(
        result.is_err(),
        "all-zero aggregate cannot satisfy the documented L2-normalized index contract: {result:?}"
    );
}

#[test]
fn exact_antipodal_cancellation_is_not_an_embedding_direction() {
    assert!(combine_window_vectors(&[vec![1.0, 0.0], vec![-1.0, 0.0]], &[1, 1]).is_err());
    assert_eq!(
        combine_window_vectors(&[vec![1.0, 0.0], vec![-1.0, 0.0]], &[3, 1]).unwrap(),
        vec![1.0, 0.0]
    );
}

#[test]
fn an_individual_zero_window_is_rejected_even_with_a_valid_neighbor() {
    assert!(combine_window_vectors(&[vec![1.0, 0.0], vec![0.0, 0.0]], &[1, 1]).is_err());
}

#[test]
fn finite_subnormal_direction_normalizes_without_a_magnitude_cutoff() {
    let mut vector = [f32::from_bits(1), f32::from_bits(2)];
    normalize(&mut vector);
    assert!(vector.iter().all(|value| value.is_finite()));
    assert!((norm_f64(&vector) - 1.0).abs() < 1e-6, "output={vector:?}");
}

#[test]
fn norm_larger_than_f32_max_still_has_a_finite_direction() {
    let mut vector = [f32::MAX, f32::MAX];
    assert!(norm_f64(&vector) > f64::from(f32::MAX));
    normalize(&mut vector);
    assert!(vector.iter().all(|value| value.is_finite()));
    assert!((norm_f64(&vector) - 1.0).abs() < 1e-6, "output={vector:?}");
}

#[test]
fn single_valid_nonunit_window_preserves_utility_identity() {
    let vector = vec![3.0, 4.0];
    assert_eq!(
        combine_window_vectors(std::slice::from_ref(&vector), &[2]).unwrap(),
        vector
    );
}

#[test]
fn mismatched_window_shapes_or_weights_are_rejected() {
    assert!(combine_window_vectors(&[], &[]).is_err());
    assert!(combine_window_vectors(&[vec![1.0]], &[]).is_err());
    assert!(combine_window_vectors(&[vec![]], &[1]).is_err());
    assert!(combine_window_vectors(&[vec![1.0], vec![1.0, 0.0]], &[1, 1]).is_err());
}

#[test]
fn legacy_void_normalization_leaves_invalid_input_unchanged() {
    for mut vector in [
        vec![],
        vec![0.0, -0.0],
        vec![f32::NAN, 1.0],
        vec![f32::INFINITY, 1.0],
    ] {
        let before: Vec<u32> = vector.iter().map(|value| value.to_bits()).collect();
        normalize(&mut vector);
        assert_eq!(
            vector
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>(),
            before
        );
    }
}

async fn ollama_response(vector: serde_json::Value) -> Result<Vec<Vec<f32>>, String> {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/embeddings"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"embedding": vector})),
        )
        .expect(1)
        .mount(&server)
        .await;
    super::embed_ollama(&server.uri(), "synthetic", &["synthetic text".into()]).await
}

#[tokio::test]
async fn numeric_ollama_rejects_non_numeric_elements_without_shortening_the_vector() {
    for vector in [
        serde_json::json!([3, "bad", 4]),
        serde_json::json!([3, null, 4]),
        serde_json::json!([3, true, 4]),
    ] {
        assert!(
            ollama_response(vector.clone()).await.is_err(),
            "malformed response was accepted: {vector}"
        );
    }
}

#[tokio::test]
async fn numeric_ollama_rejects_zero_and_f32_overflow_vectors() {
    for vector in [serde_json::json!([0, 0]), serde_json::json!([1e100, 1])] {
        assert!(
            ollama_response(vector.clone()).await.is_err(),
            "invalid response was accepted: {vector}"
        );
    }
}

#[tokio::test]
async fn numeric_ollama_rejects_inconsistent_widths_and_invalid_late_responses() {
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    for second in [serde_json::json!([1, 0, 0]), serde_json::json!([0, 0])] {
        let server = MockServer::start().await;
        for (prompt, vector) in [("first", serde_json::json!([1, 0])), ("second", second)] {
            Mock::given(method("POST"))
                .and(path("/api/embeddings"))
                .and(body_json(
                    serde_json::json!({"model": "synthetic", "prompt": prompt}),
                ))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({"embedding": vector})),
                )
                .expect(1)
                .mount(&server)
                .await;
        }
        assert!(super::embed_ollama(
            &server.uri(),
            "synthetic",
            &["first".into(), "second".into()]
        )
        .await
        .is_err());
    }
}

#[tokio::test]
async fn numeric_ollama_normalizes_finite_extreme_responses() {
    for vector in [
        serde_json::json!([3, 4]),
        serde_json::json!([1e38, 1e38]),
        serde_json::json!([1e-40, 2e-40]),
    ] {
        let result = ollama_response(vector).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].len(), 2);
        assert!(result[0].iter().all(|value| value.is_finite()));
        assert!((norm_f64(&result[0]) - 1.0).abs() < 1e-6);
    }
}

#[tokio::test]
async fn numeric_ollama_empty_input_makes_no_request() {
    assert!(super::embed_ollama("http://127.0.0.1:1", "synthetic", &[])
        .await
        .unwrap()
        .is_empty());
}

#[test]
fn numeric_checked_normalization_rejects_invalid_geometry_without_mutation() {
    for (mut vector, width) in [
        (vec![], None),
        (vec![0.0, -0.0], Some(2)),
        (vec![f32::NAN, 1.0], None),
        (vec![f32::INFINITY, 1.0], None),
        (vec![3.0, 4.0], Some(3)),
        (vec![3.0, 4.0], Some(0)),
    ] {
        let before: Vec<u32> = vector.iter().map(|value| value.to_bits()).collect();
        assert!(super::normalize_output(&mut vector, width).is_err());
        assert_eq!(
            vector
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>(),
            before
        );
    }
}

#[test]
fn numeric_batch_admission_checks_count_width_and_unit_output() {
    assert!(super::validate_embedding_batch(&[], 0, Some(384)).is_ok());
    assert!(super::validate_embedding_batch(&[], 1, Some(384)).is_err());
    assert!(super::validate_embedding_batch(&[vec![1.0, 0.0]], 0, Some(2)).is_err());
    assert!(super::validate_embedding_batch(&[vec![1.0, 0.0], vec![1.0]], 2, None).is_err());
    assert!(super::validate_embedding_batch(&[vec![3.0, 4.0]], 1, Some(2)).is_err());
    assert!(super::validate_embedding_batch(&[vec![1.0, 0.0], vec![0.0, 0.0]], 2, None).is_err());
    assert!(
        super::validate_embedding_batch(&[vec![1.0, 0.0], vec![f32::NAN, 0.0]], 2, None).is_err()
    );
    assert!(super::validate_embedding_batch(&[vec![1.0, 0.0], vec![0.0, 1.0]], 2, None).is_ok());
}

#[test]
fn numeric_e5_batch_admission_requires_the_verified_384_dimensions() {
    let dim = crate::local_llm::embed_spec_by_id("e5-small-ko")
        .unwrap()
        .output_dim;
    assert_eq!(dim, Some(384));
    for width in [383, 384, 385] {
        let mut vector = vec![0.0; width];
        vector[0] = 1.0;
        assert_eq!(
            super::validate_embedding_batch(&[vector], 1, dim).is_ok(),
            width == 384
        );
    }
}

#[test]
fn numeric_window_mean_retains_subnormal_and_large_finite_directions() {
    for value in [f32::from_bits(1), f32::MAX] {
        let output =
            combine_window_vectors(&[vec![value, 0.0], vec![value, 0.0]], &[1, 1]).unwrap();
        assert_eq!(output, vec![1.0, 0.0]);
    }
}
