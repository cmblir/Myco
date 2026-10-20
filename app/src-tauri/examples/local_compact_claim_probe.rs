//! One-shot complete-original compact claim QA with an explicit pinned weight.

use myco_lib::native_ask_probe::run_compact_suite;
use std::path::PathBuf;

fn parse(arguments: &[String]) -> Result<PathBuf, &'static str> {
    match arguments {
        [option, path] if option == "--control-artifact" && PathBuf::from(path).is_absolute() => {
            Ok(PathBuf::from(path))
        }
        _ => Err("required arguments: --control-artifact <absolute pinned artifact path>"),
    }
}

fn main() {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let result = parse(&arguments)
        .map_err(str::to_owned)
        .and_then(run_compact_suite);
    if let Err(error) = result {
        eprintln!("compact claim probe failed: {error}");
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
    fn pinned_control_path_must_be_explicit_and_absolute() {
        assert_eq!(
            parse(&args(&["--control-artifact", "/synthetic/control.gguf"])),
            Ok(PathBuf::from("/synthetic/control.gguf"))
        );
        for values in [
            vec![],
            vec!["--control-artifact"],
            vec!["--control-artifact", "relative.gguf"],
            vec!["--control-artifact", ""],
        ] {
            assert!(parse(&args(&values)).is_err());
        }
    }

    #[test]
    fn unknown_duplicate_and_retry_model_budget_options_are_rejected() {
        for values in [
            vec!["--artifact", "/synthetic/control.gguf"],
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--control-artifact",
                "/synthetic/other.gguf",
            ],
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--retry",
                "1",
            ],
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--model",
                "gemma",
            ],
            vec![
                "--control-artifact",
                "/synthetic/control.gguf",
                "--output-tokens",
                "1024",
            ],
        ] {
            assert!(parse(&args(&values)).is_err());
        }
    }
}
