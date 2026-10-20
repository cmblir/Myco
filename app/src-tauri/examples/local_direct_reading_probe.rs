//! Fixed 12B direct-answer diagnostic; no native grant, activity acceptance or publication.

#[path = "local_direct_reading_probe/advice_policy_pair.rs"]
mod advice_policy_pair;
#[path = "local_direct_reading_probe/count_fixed_reviews.rs"]
mod count_fixed_reviews;
#[path = "local_direct_reading_probe/count_formats.rs"]
mod count_formats;
#[path = "local_direct_reading_probe/development.rs"]
mod development;
#[path = "local_direct_reading_probe/fixture.rs"]
mod fixture;

use myco_lib::local_generation::direct_reading_qa;
use myco_lib::local_llm::{GenerationSchema, LocalLlm};
use myco_lib::local_model::{resolve_verified_artifact, GEMMA12B_CANDIDATE};
use myco_lib::local_synthesis::original_groups_qa::QaWireFormat;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

fn emit(value: Value) -> Result<(), String> {
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &value).map_err(|e| e.to_string())?;
    writeln!(&mut output).map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())
}

fn options(arguments: impl IntoIterator<Item = String>) -> Result<PathBuf, String> {
    let mut arguments = arguments.into_iter();
    let mut directory = None;
    let mut model = None;
    while let Some(flag) = arguments.next() {
        let slot = match flag.as_str() {
            "--model-dir" => &mut directory,
            "--model-id" => &mut model,
            _ => return Err(format!("unsupported direct-reading argument: {flag}")),
        };
        let value = arguments
            .next()
            .filter(|v| !v.is_empty() && !v.starts_with("--"))
            .ok_or_else(|| format!("missing value for {flag}"))?;
        if slot.replace(value).is_some() {
            return Err(format!("repeated direct-reading argument: {flag}"));
        }
    }
    if model.as_deref() != Some(GEMMA12B_CANDIDATE.id) {
        return Err("explicit pinned Gemma12B model ID required".into());
    }
    let path = PathBuf::from(directory.ok_or("explicit model directory required")?);
    if !path.is_absolute() {
        return Err("absolute model directory required".into());
    }
    Ok(path)
}

fn run(directory: PathBuf) -> Result<(), String> {
    // Source/schema binding precedes model resolution. No private vault is read.
    let prepared = (0..2).map(fixture::bind).collect::<Result<Vec<_>, _>>()?;
    emit(
        json!({"phase":"direct_reading_admission","model":GEMMA12B_CANDIDATE,
        "compiledSourceSha256":fixture::RAW_SHA,"questions":direct_reading_qa::QUESTIONS,
        "suppliedOriginalSpans":2,"maximumGenerations":4,"corrections":0,"retries":0,
        "sourceIdentity":"synthetic-new-identities; not byte-identical historical USER",
        "periodContext":"explicit historical recorded context; no fresh planner or current-state evidence",
        "native_io_authenticated":false,"product_role_authorized":false,
        "activityClaimReview":"not_run","activityContractAccepted":false,"semantic_accepted":false,"production_accepted":false}),
    )?;
    let model = resolve_verified_artifact(&directory, &GEMMA12B_CANDIDATE)?;
    let mut host = LocalLlm::load_embed_host()?;
    let result = (|| {
        host.ensure_chat_model(&model)?;
        let mut failures = Vec::new();
        for (index, (request, evidence, sources)) in prepared.iter().enumerate() {
            let mut calls = 0;
            let result = direct_reading_qa::run(
                request,
                evidence,
                sources,
                request.origin.as_ref().ok_or("synthetic binding absent")?,
                |system, user| {
                    let counted = host.chat_token_count(system, user);
                    emit(json!({"phase":"direct_reading_count","questionIndex":index,
                        "systemSha256":fixture::hash(system),"userSha256":fixture::hash(user),
                        "tokenCount":counted.as_ref().ok(),"error":counted.as_ref().err(),
                        "contextTokens":4096,"outputTokens":768,"reserve":8}))?;
                    counted
                },
                |system, user, output, context, schema| {
                    calls += 1;
                    if calls > 2
                        || (output, context) != (768, 4096)
                        || !matches!(
                            schema,
                            GenerationSchema::AskAnswerV1 | GenerationSchema::AskAnswerReviewV1
                        )
                    {
                        return Err("direct-reading stage/budget contract changed".into());
                    }
                    let started = Instant::now();
                    let attempt = host.generate_gemma12b_ordinal_cancellable_measured_qa(
                        system,
                        user,
                        output,
                        context,
                        schema,
                        &AtomicBool::new(false),
                    );
                    let telemetry =
                        serde_json::to_value(attempt.telemetry()).map_err(|e| e.to_string());
                    let generated = attempt.into_result();
                    let expected_schema = if schema == GenerationSchema::AskAnswerV1 {
                        "askAnswerV1"
                    } else {
                        "askAnswerReviewV1"
                    };
                    let clean = telemetry.as_ref().is_ok_and(|t| {
                        t["profile"] == "gemma12BOrdinalQaV1"
                            && t["schema"] == expected_schema
                            && t["requestedOutputTokens"] == 768
                            && t["requestedContextTokens"] == 4096
                            && t["loopStop"] == "eog"
                            && t["terminal"] == "returnedText"
                            && t["pendingUtf8Bytes"] == 0
                            && t["errorCode"].is_null()
                    });
                    // Observe raw output before parsing, draft validation, or the next review.
                    emit(
                        json!({"phase":"direct_reading_generation","questionIndex":index,"call":calls,
                        "system":system,"user":user,"systemSha256":fixture::hash(system),"userSha256":fixture::hash(user),
                        "grammarSha256":schema.qa_grammar_sha256(),"telemetry":telemetry.as_ref().ok(),
                        "telemetryError":telemetry.as_ref().err(),"rawOutput":generated.as_ref().ok(),
                        "rawOutputSha256":generated.as_ref().ok().map(|s|fixture::hash(s)),"error":generated.as_ref().err(),
                        "cleanObservedDecode":clean,"elapsedSeconds":started.elapsed().as_secs_f64(),
                        "native_io_authenticated":false,"product_role_authorized":false,"semantic_accepted":false,"production_accepted":false}),
                    )?;
                    if !clean {
                        return Err("direct-reading decode telemetry was not clean EOG".into());
                    }
                    generated
                },
            );
            emit(
                json!({"phase":"direct_reading_question_terminal","questionIndex":index,
                "question":request.question,"generationCalls":calls,"diagnostic":result.as_ref().ok(),
                "error":result.as_ref().err().map(|e|json!({"code":e.code,"detail":e.detail})),
                "meaningReview":"independent audit required; same-model approval is not truth",
                "activityContractAccepted":false,"semantic_accepted":false,"production_accepted":false}),
            )?;
            if let Err(error) = result {
                failures.push(format!(
                    "question {index}: {}: {}",
                    error.code, error.detail
                ));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    })();
    drop(host);
    emit(
        json!({"phase":"direct_reading_host_dropped","ownedHostDropCompleted":true,
        "gpuMemoryReturnObserved":false,"processGlobalBackendReleaseObserved":false}),
    )?;
    result
}

struct SelectedMode {
    development: bool,
    count_formats: bool,
    grouped: bool,
    fixed_reviews: Option<PathBuf>,
    advice_pair: bool,
    directory: PathBuf,
}

fn selected_mode(arguments: impl IntoIterator<Item = String>) -> Result<SelectedMode, String> {
    let mut development = false;
    let mut count_formats = false;
    let mut grouped = false;
    let mut advice_pair = false;
    let mut retained = Vec::new();
    let mut fixed_reviews = None;
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        if argument == "--count-fixed-reviews-only" {
            if fixed_reviews.is_some() {
                return Err("repeated --count-fixed-reviews-only".into());
            }
            let value = arguments
                .next()
                .filter(|value| !value.is_empty() && !value.starts_with("--"))
                .ok_or("missing sealed stdout path for --count-fixed-reviews-only")?;
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err("absolute sealed stdout path required".into());
            }
            fixed_reviews = Some(path);
            continue;
        }
        if matches!(
            argument.as_str(),
            "--development-cases"
                | "--count-formats-only"
                | "--grouped-originals-qa"
                | "--advice-policy-pair-qa"
        ) {
            let flag = match argument.as_str() {
                "--development-cases" => &mut development,
                "--count-formats-only" => &mut count_formats,
                "--grouped-originals-qa" => &mut grouped,
                _ => &mut advice_pair,
            };
            if *flag {
                return Err(format!("repeated {argument}"));
            }
            *flag = true;
        } else {
            retained.push(argument);
        }
    }
    if count_formats && !development {
        return Err("--count-formats-only requires --development-cases".into());
    }
    if grouped && !development {
        return Err("--grouped-originals-qa requires --development-cases".into());
    }
    if grouped && count_formats {
        return Err("--grouped-originals-qa cannot be combined with --count-formats-only".into());
    }
    if fixed_reviews.is_some() && (!development || !grouped || count_formats) {
        return Err("--count-fixed-reviews-only requires --development-cases --grouped-originals-qa and excludes --count-formats-only".into());
    }
    if advice_pair && (!development || !grouped || count_formats || fixed_reviews.is_some()) {
        return Err("--advice-policy-pair-qa requires --development-cases --grouped-originals-qa and excludes count-only modes".into());
    }
    Ok(SelectedMode {
        development,
        count_formats,
        grouped,
        fixed_reviews,
        advice_pair,
        directory: options(retained)?,
    })
}

fn main() {
    let selected = selected_mode(std::env::args().skip(1));
    let development_mode = selected.as_ref().is_ok_and(|mode| mode.development);
    let count_mode = selected.as_ref().is_ok_and(|mode| mode.count_formats);
    let fixed_mode = selected
        .as_ref()
        .is_ok_and(|mode| mode.fixed_reviews.is_some());
    let advice_pair_mode = selected.as_ref().is_ok_and(|mode| mode.advice_pair);
    let format = if selected.as_ref().is_ok_and(|mode| mode.grouped) {
        QaWireFormat::SourceDocumentGroupsQaV1
    } else {
        QaWireFormat::Flat
    };
    let result = selected.and_then(|mode| {
        let SelectedMode {
            development: development_mode,
            count_formats: count_mode,
            fixed_reviews: fixed,
            directory,
            advice_pair,
            ..
        } = mode;
        if advice_pair {
            advice_policy_pair::run(directory)
        } else if let Some(log) = fixed {
            count_fixed_reviews::run(directory, log)
        } else if count_mode {
            count_formats::run(directory)
        } else if development_mode {
            development::run_with_wire_format(directory, format)
        } else {
            run(directory)
        }
    });
    let terminal = if advice_pair_mode {
        emit(
            json!({"phase":"advice_policy_pair_terminal","error":result.as_ref().err(),
            "scheduledCases":4,"scheduledCaseArms":8,"positiveArms":6,"goalClarificationArms":2,
            "maximumGenerations":16,"maximumGenerationsPerArm":2,"corrections":0,"retries":0,
            "knownDevelopmentCases":true,"heldOut":false,"referenceCriteriaServedToModel":false,
            "native_io_authenticated":false,"product_role_authorized":false,"activityContractAccepted":false,
            "semantic_accepted":false,"production_accepted":false,"installedAcceptance":false}),
        )
    } else if fixed_mode {
        emit(
            json!({"phase":"count_fixed_reviews_terminal","error":result.as_ref().err(),
            "scheduledCases":7,"maximumGenerations":0,"actualWriterGenerations":0,"actualReviewGenerations":0,
            "meaning":"not_assessed","reviewVerdicts":"not_generated","semantic_accepted":false,
            "production_accepted":false,"native_io_authenticated":false,"product_role_authorized":false,
            "installedAcceptance":false}),
        )
    } else if count_mode {
        emit(
            json!({"phase":"count_formats_terminal","error":result.as_ref().err(),
            "scheduledCases":7,"generationCalls":0,"semantic_accepted":false,
            "production_accepted":false,"native_io_authenticated":false,
            "product_role_authorized":false,"installedAcceptance":false}),
        )
    } else if development_mode {
        emit(
            json!({"phase":"development_reading_terminal","wireFormat":format,"error":result.as_ref().err(),
            "scheduledCases":7,"maximumGenerations":14,"maximumGenerationsPerCase":2,
            "native_io_authenticated":false,"product_role_authorized":false,
            "activityClaimReview":"not_run","activityContractAccepted":false,
            "semantic_accepted":false,"production_accepted":false,"installedAcceptance":false}),
        )
    } else {
        emit(
            json!({"phase":"direct_reading_terminal","error":result.as_ref().err(),
        "native_io_authenticated":false,"product_role_authorized":false,
        "activityClaimReview":"not_run","activityContractAccepted":false,
        "semantic_accepted":false,"production_accepted":false,"installedAcceptance":false}),
        )
    };
    if result.is_err() || terminal.is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn explicit_manifest_and_absolute_model_directory_are_required() {
        assert_eq!(
            options(args(&[
                "--model-id",
                GEMMA12B_CANDIDATE.id,
                "--model-dir",
                "/synthetic/models"
            ]))
            .unwrap(),
            PathBuf::from("/synthetic/models")
        );
        assert!(options(args(&["--model-dir", "/synthetic/models"])).is_err());
        assert!(options(args(&[
            "--model-id",
            "qwen3.5-4b-q4_k_m",
            "--model-dir",
            "/synthetic/models"
        ]))
        .is_err());
        assert!(options(args(&[
            "--model-id",
            GEMMA12B_CANDIDATE.id,
            "--model-dir",
            "relative"
        ]))
        .is_err());
    }

    #[test]
    fn development_mode_is_explicit_and_rejects_repeated_or_valued_flags() {
        let base = [
            "--model-id",
            GEMMA12B_CANDIDATE.id,
            "--model-dir",
            "/synthetic/models",
        ];
        assert!(!selected_mode(args(&base)).unwrap().development);
        let mut development = args(&base);
        development.push("--development-cases".into());
        assert!(selected_mode(development.clone()).unwrap().development);
        development.push("--development-cases".into());
        assert!(selected_mode(development).is_err());
        assert!(selected_mode(args(&["--development-cases", "true"])).is_err());
    }

    #[test]
    fn count_formats_requires_explicit_development_and_no_values_or_repetition() {
        let base = [
            "--model-id",
            GEMMA12B_CANDIDATE.id,
            "--model-dir",
            "/synthetic/models",
        ];
        let mut arguments = args(&base);
        arguments.push("--count-formats-only".into());
        assert!(selected_mode(arguments.clone()).is_err());
        arguments.push("--development-cases".into());
        assert!(selected_mode(arguments.clone()).unwrap().count_formats);
        let mut valued = arguments.clone();
        valued.push("true".into());
        assert!(selected_mode(valued).is_err());
        arguments.push("--count-formats-only".into());
        assert!(selected_mode(arguments).is_err());
    }

    #[test]
    fn grouped_serving_requires_development_and_rejects_count_mixing_values_and_duplicates() {
        let mut arguments = args(&[
            "--model-id",
            GEMMA12B_CANDIDATE.id,
            "--model-dir",
            "/synthetic/models",
        ]);
        assert!(!selected_mode(arguments.clone()).unwrap().grouped);
        arguments.push("--grouped-originals-qa".into());
        assert!(selected_mode(arguments.clone()).is_err());
        arguments.push("--development-cases".into());
        let selected = selected_mode(arguments.clone()).unwrap();
        assert!(selected.development && selected.grouped && !selected.count_formats);
        let mut valued = arguments.clone();
        valued.push("true".into());
        assert!(selected_mode(valued).is_err());
        let mut counted = arguments.clone();
        counted.push("--count-formats-only".into());
        assert!(selected_mode(counted).is_err());
        arguments.push("--grouped-originals-qa".into());
        assert!(selected_mode(arguments).is_err());
    }

    #[test]
    fn duplicate_unknown_and_missing_arguments_are_rejected() {
        assert!(options(args(&[
            "--model-id",
            GEMMA12B_CANDIDATE.id,
            "--model-id",
            GEMMA12B_CANDIDATE.id
        ]))
        .is_err());
        assert!(options(args(&["--model-dir"])).is_err());
        assert!(options(args(&["--retry", "1"])).is_err());
    }

    #[test]
    fn fixed_review_count_requires_grouped_development_and_rejects_mixed_or_repeated_modes() {
        let mut arguments = args(&[
            "--model-id",
            GEMMA12B_CANDIDATE.id,
            "--model-dir",
            "/synthetic/models",
            "--count-fixed-reviews-only",
            "/synthetic/native-stdout.log",
        ]);
        assert!(selected_mode(arguments.clone()).is_err());
        arguments.push("--development-cases".into());
        assert!(selected_mode(arguments.clone()).is_err());
        arguments.push("--grouped-originals-qa".into());
        assert_eq!(
            selected_mode(arguments.clone()).unwrap().fixed_reviews,
            Some(PathBuf::from("/synthetic/native-stdout.log"))
        );
        let mut mixed = arguments.clone();
        mixed.push("--count-formats-only".into());
        assert!(selected_mode(mixed).is_err());
        let mut repeated = arguments.clone();
        repeated.extend(args(&[
            "--count-fixed-reviews-only",
            "/synthetic/other.log",
        ]));
        assert!(selected_mode(repeated).is_err());
        let mut relative = arguments.clone();
        relative[5] = "native-stdout.log".into();
        assert!(selected_mode(relative).is_err());
        let mut missing = arguments;
        missing.remove(5);
        assert!(selected_mode(missing).is_err());
    }

    #[test]
    fn advice_policy_pair_requires_grouped_development_and_rejects_count_modes_values_and_repetition(
    ) {
        let mut arguments = args(&[
            "--model-id",
            GEMMA12B_CANDIDATE.id,
            "--model-dir",
            "/synthetic/models",
            "--advice-policy-pair-qa",
        ]);
        assert!(selected_mode(arguments.clone()).is_err());
        arguments.push("--development-cases".into());
        assert!(selected_mode(arguments.clone()).is_err());
        arguments.push("--grouped-originals-qa".into());
        assert!(selected_mode(arguments.clone()).unwrap().advice_pair);
        for extra in [
            args(&["--count-formats-only"]),
            args(&["--count-fixed-reviews-only", "/synthetic/native-stdout.log"]),
            args(&["--advice-policy-pair-qa"]),
            args(&["true"]),
        ] {
            let mut invalid = arguments.clone();
            invalid.extend(extra);
            assert!(selected_mode(invalid).is_err());
        }
        let mut valued = arguments;
        valued.retain(|argument| argument != "--advice-policy-pair-qa");
        valued.push("--advice-policy-pair-qa=true".into());
        assert!(selected_mode(valued).is_err());
    }
}
