//! Explicit local-data diagnostic; never compiled into the application.

use super::*;
use std::cell::RefCell;
use std::io::Write;

const COMPARISON_MODEL: local_model::ModelManifest = local_model::ModelManifest {
    id: "qwen3.5-9b-q4_k_m",
    repository: "lmstudio-community/Qwen3.5-9B-GGUF",
    revision: "1379f25c6b505a3fc737bd7818cb09389cf807c1",
    file: "Qwen3.5-9B-Q4_K_M.gguf",
    url: "https://huggingface.co/lmstudio-community/Qwen3.5-9B-GGUF/resolve/1379f25c6b505a3fc737bd7818cb09389cf807c1/Qwen3.5-9B-Q4_K_M.gguf",
    bytes: 5_627_044_256,
    sha256: "cd76ec205963b3b33350093e6904d9de16c4e666fd104e1f632d25c7f15f2a13",
    license: "Apache-2.0",
    adapter: None,
};

#[derive(Deserialize)]
struct Probe {
    index: PathBuf,
    output: PathBuf,
    generate: bool,
    requests: Vec<Request>,
    #[serde(default)]
    system_override: Option<String>,
    #[serde(default)]
    omit_reminder: bool,
    #[serde(default)]
    comparison_model_dir: Option<PathBuf>,
}

/// Run only with MYCO_ACTIVITY_PROBE_CONFIG pointing to an explicit private
/// configuration. Complete prompts stay in a newly created owner-only file.
#[test]
#[ignore = "requires an explicit private vault/index configuration and verified local weights"]
fn inspect_activity_context() -> Result<(), String> {
    let config = std::env::var_os("MYCO_ACTIVITY_PROBE_CONFIG")
        .ok_or("private activity probe configuration is required")?;
    let probe: Probe = serde_json::from_slice(
        &std::fs::read(config).map_err(|_| "probe configuration unreadable")?,
    )
    .map_err(|_| "invalid probe configuration")?;
    let index = Bm25Index::load(&probe.index);
    if index.is_empty() || probe.requests.is_empty() || probe.requests.len() > 8 {
        return Err("probe requires an existing index and one to eight requests".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(&probe.output)
        .map_err(|_| "probe output must be a new file in an existing private directory")?;
    let mut model = LocalLlm::load_embed_host()?;
    for mut request in probe.requests {
        let root = PathBuf::from(&request.expected_vault);
        if !request.activity_overview {
            return Err("probe requires an activity request".into());
        }
        let range = request.range.as_ref().ok_or("probe requires a period")?;
        let recalled = crate::activity_recall::recall(
            &root,
            &index,
            range,
            request.scope,
            request.paths.as_deref(),
            false,
        )?;
        request.hits = recalled.hits.clone();
        let checked = checked_evidence(&root, &index, &request)?;
        let (manifest, directory) = if let Some(directory) = &probe.comparison_model_dir {
            (&COMPARISON_MODEL, directory.clone())
        } else {
            (
                local_model::manifest_for(request.model_id.as_deref())?,
                local_model::model_dir()?,
            )
        };
        let package = local_model::resolve_verified_package(&directory, manifest)?;
        model.ensure_chat_package(&package)?;
        let captured = RefCell::new(serde_json::Value::Null);
        let started = std::time::Instant::now();
        let result = synthesis_steps(
            &request,
            &checked.evidence,
            |system, user| model.chat_token_count(system, user),
            |system, user, max_tokens| {
                let system = probe.system_override.as_deref().unwrap_or(system);
                let mut payload: serde_json::Value =
                    serde_json::from_str(user).map_err(|_| "invalid probe prompt")?;
                if probe.omit_reminder {
                    payload
                        .as_object_mut()
                        .ok_or("invalid probe payload")?
                        .remove("output_reminder");
                }
                let user = if probe.omit_reminder {
                    serde_json::to_string(&payload).map_err(|_| "invalid probe payload")?
                } else {
                    user.to_owned()
                };
                *captured.borrow_mut() = serde_json::json!({
                    "system":system,"user":payload,
                    "tokens":model.chat_token_count(system,&user)?,"output_tokens":max_tokens,
                });
                let raw = if probe.generate {
                    model.generate_cancellable(
                        system,
                        &user,
                        max_tokens,
                        &AtomicBool::new(false),
                    )?
                } else {
                    "{\"answer\":\"\",\"sources\":[]}".into()
                };
                captured.borrow_mut()["raw"] = serde_json::json!(raw);
                Ok(raw)
            },
        );
        let row = serde_json::json!({
            "question":request.question,"range":{"start":range.start,"end":range.end},"model":manifest.id,
            "recall":recalled,"prompt":captured.into_inner(),"result":result,
            "source_revisions":checked.revisions,"generated":probe.generate,
            "seconds":started.elapsed().as_secs_f64(),
        });
        serde_json::to_writer(&mut output, &row)
            .map_err(|_| "cannot write private probe result")?;
        output
            .write_all(b"\n")
            .map_err(|_| "cannot finish private probe result")?;
        output
            .flush()
            .map_err(|_| "cannot flush private probe result")?;
    }
    Ok(())
}
