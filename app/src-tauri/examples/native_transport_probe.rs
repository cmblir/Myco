//! Model-free one-shot diagnostics through the native Ask reply transport.

use myco_lib::native_ask_probe::{run_transport, BackgroundPolicyQa};

fn parse(arguments: &[String]) -> Result<BackgroundPolicyQa, &'static str> {
    match arguments {
        [option, value] if option == "--background-policy" => match value.as_str() {
            "default" => Ok(BackgroundPolicyQa::Default),
            "disabled" => Ok(BackgroundPolicyQa::Disabled),
            _ => Err("background policy must be default or disabled"),
        },
        _ => Err("required arguments: --background-policy <default|disabled>"),
    }
}

fn main() {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let policy = parse(&arguments).unwrap_or_else(|error| {
        eprintln!("native transport arguments: {error}");
        std::process::exit(1);
    });
    std::process::exit(run_transport(policy));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn both_registered_policies_require_explicit_selection() {
        assert_eq!(
            parse(&args(&["--background-policy", "default"])),
            Ok(BackgroundPolicyQa::Default)
        );
        assert_eq!(
            parse(&args(&["--background-policy", "disabled"])),
            Ok(BackgroundPolicyQa::Disabled)
        );
        assert!(parse(&[]).is_err());
        assert!(parse(&args(&["--background-policy"])).is_err());
    }

    #[test]
    fn unsupported_duplicate_and_timing_model_options_are_rejected() {
        for values in [
            vec!["--background-policy", "suspend"],
            vec![
                "--background-policy",
                "default",
                "--background-policy",
                "disabled",
            ],
            vec!["--background-policy", "disabled", "--visible-window"],
            vec![
                "--background-policy",
                "disabled",
                "--control-artifact",
                "/synthetic/unused.gguf",
            ],
            vec![
                "--background-policy",
                "disabled",
                "--watchdog-seconds",
                "900",
            ],
        ] {
            assert!(
                parse(&args(&values)).is_err(),
                "accepted unregistered arguments: {values:?}"
            );
        }
    }
}
