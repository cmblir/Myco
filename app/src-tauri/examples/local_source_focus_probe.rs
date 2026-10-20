//! One-shot complete-original source-focus QA using an explicit pinned artifact.

use myco_lib::local_model::{GEMMA_CANDIDATE, MODEL};
use myco_lib::native_ask_probe::{run_source_focus_suite, run_source_focus_suite_for};
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
struct Arguments {
    control_artifact: PathBuf,
    model_id: Option<String>,
}

fn parse(arguments: &[String]) -> Result<Arguments, &'static str> {
    let mut control_artifact = None;
    let mut model_id = None;
    let mut options = arguments.iter();
    while let Some(option) = options.next() {
        match option.as_str() {
            "--control-artifact" => {
                if control_artifact.is_some() {
                    return Err("duplicate control artifact");
                }
                let path = options.next().ok_or("control artifact path is missing")?;
                let path = PathBuf::from(path);
                if !path.is_absolute() {
                    return Err("control artifact path must be absolute");
                }
                control_artifact = Some(path);
            }
            "--model-id" => {
                if model_id.is_some() {
                    return Err("duplicate model ID");
                }
                let id = options.next().ok_or("model ID is missing")?;
                if id.as_str() != MODEL.id && id.as_str() != GEMMA_CANDIDATE.id {
                    return Err("unsupported source focus suite model ID");
                }
                model_id = Some(id.clone());
            }
            _ => return Err("unsupported source focus suite option"),
        }
    }
    Ok(Arguments {
        control_artifact: control_artifact.ok_or("control artifact is required")?,
        model_id,
    })
}

fn main() {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let result = parse(&arguments)
        .map_err(str::to_owned)
        .and_then(|arguments| match arguments.model_id {
            Some(id) => run_source_focus_suite_for(arguments.control_artifact, &id),
            None => run_source_focus_suite(arguments.control_artifact),
        });
    if let Err(error) = result {
        eprintln!("source focus probe failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn control_artifact_is_explicit_absolute_and_unambiguous() {
        assert_eq!(
            parse(&args(&["--control-artifact", "/synthetic/control.gguf"])),
            Ok(Arguments {
                control_artifact: PathBuf::from("/synthetic/control.gguf"),
                model_id: None,
            })
        );
        for values in [
            vec![],
            vec!["--control-artifact"],
            vec!["--control-artifact", "relative.gguf"],
            vec!["--control-artifact", ""],
            vec!["--artifact", "/synthetic/control.gguf"],
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--control-artifact",
                "/synthetic/other.gguf",
            ],
        ] {
            assert!(parse(&args(&values)).is_err());
        }
    }

    #[test]
    fn sampler_budget_retry_and_other_extra_options_are_rejected() {
        for extra in [
            ["--model", "gemma"],
            ["--sampler", "no-presence"],
            ["--output-tokens", "1536"],
            ["--context-tokens", "8192"],
            ["--retry", "1"],
        ] {
            assert!(parse(&args(&[
                "--control-artifact",
                "/synthetic/control.gguf",
                extra[0],
                extra[1]
            ]))
            .is_err());
        }
        assert!(parse(&args(&[
            "--control-artifact",
            "/synthetic/control.gguf",
            "--help"
        ]))
        .is_err());
    }

    #[test]
    fn both_pinned_model_ids_are_optional_explicit_and_order_independent() {
        for id in [MODEL.id, GEMMA_CANDIDATE.id] {
            for values in [
                vec![
                    "--control-artifact",
                    "/synthetic/control.gguf",
                    "--model-id",
                    id,
                ],
                vec![
                    "--model-id",
                    id,
                    "--control-artifact",
                    "/synthetic/control.gguf",
                ],
            ] {
                assert_eq!(
                    parse(&args(&values)),
                    Ok(Arguments {
                        control_artifact: PathBuf::from("/synthetic/control.gguf"),
                        model_id: Some(id.into()),
                    })
                );
            }
        }
    }

    #[test]
    fn ambiguous_missing_unknown_or_unpinned_model_ids_are_rejected() {
        for values in [
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--model-id",
            ],
            vec!["--model-id", GEMMA_CANDIDATE.id],
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--model-id",
                "",
            ],
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--model-id",
                "gemma",
            ],
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--model-id",
                myco_lib::local_model::SMALL_MODEL.id,
            ],
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--model-id",
                MODEL.id,
                "--model-id",
                GEMMA_CANDIDATE.id,
            ],
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--model-id=qwen3.5-4b-q4_k_m",
            ],
        ] {
            assert!(parse(&args(&values)).is_err());
        }
    }
}
