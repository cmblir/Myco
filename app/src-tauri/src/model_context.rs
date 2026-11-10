//! Tokenizer capabilities belong to the explicitly selected runtime. These
//! read/count calls never prepare weights or execute generation.
use crate::providers::ChatMessage;
use crate::role_authorization::{ExecutionLocation, RoleId, RoleSnapshot, RoleUsage};
use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::sync::Mutex;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    provider: String,
    model: String,
    origin: AgentVaultSession,
    role_snapshot: RoleSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    model: String,
    context_tokens: u32,
    output_tokens: u32,
    tokenizer_revision: String,
}

impl Capability {
    fn check(&self, model: &str) -> Result<(), String> {
        if self.model != model
            || self.output_tokens == 0
            || self.context_tokens <= self.output_tokens
            || self.context_tokens > 16_777_216
            || self.tokenizer_revision.is_empty()
            || self.tokenizer_revision.len() > 256
        {
            return Err("invalid selected runtime context capability".into());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct Capabilities {
    models: Vec<Capability>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountRequest {
    #[serde(flatten)]
    binding: Binding,
    messages: Vec<ChatMessage>,
    tokenizer_revision: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Count {
    model: String,
    tokenizer_revision: String,
    prompt_tokens: u32,
    context_tokens: u32,
    output_tokens: u32,
}

fn endpoint(vault: &VaultRoot, binding: &Binding) -> Result<Option<String>, String> {
    crate::commands::authorized_role(
        vault,
        &binding.origin,
        &binding.role_snapshot,
        RoleId::Ask,
        |_| {
            let snapshot = &binding.role_snapshot;
            if snapshot.usage != RoleUsage::Foreground
                || binding.provider != snapshot.route_signature.provider_id
                || binding.model != snapshot.route_signature.model_id
            {
                return Err(
                    "request_route_mismatch: tokenizer requires the selected foreground Ask".into(),
                );
            }
            if binding.provider != "ollama"
                || snapshot.route_signature.execution_location != ExecutionLocation::Loopback
            {
                return Ok(None);
            }
            Ok(Some(crate::providers::ollama_endpoint(
                &crate::settings::read_checked()?,
            )))
        },
    )
}

async fn guarded<T>(
    vault: &VaultRoot,
    binding: &Binding,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    endpoint(vault, binding)?;
    tokio::pin!(future);
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(25));
    loop {
        tokio::select! {
            value = &mut future => { let result = value?; endpoint(vault, binding)?; return Ok(result); }
            _ = tick.tick() => { endpoint(vault, binding)?; }
        }
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

pub(crate) async fn budget(
    vault: &VaultRoot,
    binding: &Binding,
) -> Result<Option<Capability>, String> {
    let Some(base) = endpoint(vault, binding)? else {
        return Ok(None);
    };
    guarded(vault, binding, async {
        let response = client()?
            .get(format!(
                "{}/api/myco-capabilities",
                base.trim_end_matches('/')
            ))
            .send()
            .await
            .map_err(|e| format!("model capability: {e}"))?;
        if matches!(response.status().as_u16(), 404 | 405) {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("model capability HTTP {}", response.status()));
        }
        let bytes = crate::providers::read_capped(response, 64 * 1024).await?;
        let all: Capabilities =
            serde_json::from_slice(&bytes).map_err(|e| format!("model capability: {e}"))?;
        if all.models.len() > 128 {
            return Err("too many runtime model capabilities".into());
        }
        let mut matches = all.models.into_iter().filter(|c| c.model == binding.model);
        let capability = matches
            .next()
            .ok_or("selected model has no tokenizer capability")?;
        if matches.next().is_some() {
            return Err("ambiguous runtime model capability".into());
        }
        capability.check(&binding.model)?;
        Ok(Some(capability))
    })
    .await
}

pub(crate) async fn count(vault: &VaultRoot, request: &CountRequest) -> Result<Count, String> {
    let base =
        endpoint(vault, &request.binding)?.ok_or("tokenizer unavailable on this selected route")?;
    if request.messages.len() > 128
        || request.tokenizer_revision.is_empty()
        || request.tokenizer_revision.len() > 256
        || request
            .messages
            .iter()
            .any(|m| !matches!(m.role.as_str(), "system" | "user" | "assistant"))
        || request
            .messages
            .iter()
            .map(|m| m.content.len())
            .sum::<usize>()
            > 2 * 1024 * 1024
    {
        return Err("tokenizer input exceeds the supported message contract".into());
    }
    guarded(vault, &request.binding, async {
        let response = client()?
            .post(format!("{}/api/myco-tokenize", base.trim_end_matches('/')))
            .json(
                &serde_json::json!({"model":request.binding.model,"messages":request.messages,
                "tokenizerRevision":request.tokenizer_revision}),
            )
            .send()
            .await
            .map_err(|e| format!("model tokenizer: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("model tokenizer HTTP {}", response.status()));
        }
        let bytes = crate::providers::read_capped(response, 64 * 1024).await?;
        let result: Count =
            serde_json::from_slice(&bytes).map_err(|e| format!("model tokenizer: {e}"))?;
        Capability {
            model: result.model.clone(),
            tokenizer_revision: result.tokenizer_revision.clone(),
            context_tokens: result.context_tokens,
            output_tokens: result.output_tokens,
        }
        .check(&request.binding.model)?;
        if result.tokenizer_revision != request.tokenizer_revision {
            return Err("runtime tokenizer revision changed".into());
        }
        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn model_context_budget(
    vault: tauri::State<'_, VaultRoot>,
    request: Binding,
) -> Result<Option<Capability>, String> {
    budget(&vault, &request).await
}

#[tauri::command]
pub async fn count_model_context(
    vault: tauri::State<'_, VaultRoot>,
    request: CountRequest,
) -> Result<Count, String> {
    count(&vault, &request).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRequest {
    #[serde(flatten)]
    binding: Binding,
    audit: serde_json::Value,
}

static AUDIT_WRITE: Mutex<()> = Mutex::new(());

/// The ranked hits behind a packing: scores and identity only, never text.
fn retrieval_trace(value: &serde_json::Value) -> Result<serde_json::Value, String> {
    let hits = value["hits"]
        .as_array()
        .ok_or("context audit retrieval missing hits")?;
    let dense_skipped = match value.get("denseSkipped") {
        None | Some(serde_json::Value::Null) => serde_json::Value::Null,
        Some(serde_json::Value::String(reason)) if reason.len() <= 256 => {
            serde_json::Value::String(reason.clone())
        }
        Some(_) => return Err("invalid context audit retrieval".into()),
    };
    if hits.len() > 64 {
        return Err("context audit retrieval too many hits".into());
    }
    let hits = hits
        .iter()
        .map(|hit| {
            if hit["page"].as_str().is_none_or(|page| page.len() > 4096)
                || hit["section"].as_u64().is_none()
            {
                return Err("invalid context audit retrieval hit".to_string());
            }
            let mut row = serde_json::Map::new();
            for key in [
                "page",
                "section",
                "scoreRrf",
                "scoreFinal",
                "similarity",
                "exactMatch",
            ] {
                if let Some(v) = hit.get(key).filter(|v| !v.is_object() && !v.is_array()) {
                    row.insert(key.into(), v.clone());
                }
            }
            Ok(serde_json::Value::Object(row))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(serde_json::json!({"denseSkipped": dense_skipped, "hits": hits}))
}

fn passage_metadata(value: &serde_json::Value, omitted: bool) -> Result<serde_json::Value, String> {
    let page = value["page"]
        .as_str()
        .ok_or("context audit passage missing source")?;
    value["section"]
        .as_u64()
        .ok_or("context audit passage missing section")?;
    let hash = value["textSha256"]
        .as_str()
        .ok_or("context audit passage missing hash")?;
    if page.len() > 4096
        || hash.len() != 64
        || !hash.bytes().all(|c| c.is_ascii_hexdigit())
        || (omitted && value["reason"].as_str().is_none())
    {
        return Err("invalid context audit passage metadata".into());
    }
    let mut result = serde_json::Map::new();
    for key in [
        "page",
        "stem",
        "section",
        "textSha256",
        "sourceRevision",
        "speaker",
        "timestamp",
        "messageId",
        "relation",
        "anchorPage",
        "anchorSection",
        "reason",
    ] {
        if let Some(v) = value.get(key) {
            result.insert(key.into(), v.clone());
        }
    }
    Ok(serde_json::Value::Object(result))
}

/// Store minimal provenance, not a duplicate corpus or synthetic vault record.
#[tauri::command]
pub fn record_context_packing(
    vault: tauri::State<'_, VaultRoot>,
    request: AuditRequest,
) -> Result<(), String> {
    endpoint(&vault, &request.binding)?;
    crate::commands::authorized_role(
        &vault,
        &request.binding.origin,
        &request.binding.role_snapshot,
        RoleId::Ask,
        |root| {
            let audit = &request.audit;
            let prompt = audit["promptTokens"]
                .as_u64()
                .ok_or("context audit missing prompt token count")?;
            let context = audit["contextTokens"]
                .as_u64()
                .ok_or("context audit missing allowance")?;
            let output = audit["outputTokens"]
                .as_u64()
                .ok_or("context audit missing output reserve")?;
            let status = audit["status"]
                .as_str()
                .ok_or("context audit missing status")?;
            let messages_hash = audit["messagesSha256"]
                .as_str()
                .ok_or("context audit missing message identity")?;
            if audit["version"].as_u64() != Some(1)
                || output == 0
                || context <= output
                || !matches!(status, "packed" | "base_overflow" | "final_overflow")
                || (status == "packed"
                    && prompt
                        .checked_add(output)
                        .is_none_or(|total| total > context))
                || messages_hash.len() != 64
                || !messages_hash.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err("invalid context packing audit".into());
            }
            let selected = audit["selected"]
                .as_array()
                .ok_or("context audit missing selections")?;
            let omitted = audit["omitted"]
                .as_array()
                .ok_or("context audit missing omissions")?;
            if selected.len() + omitted.len() > 4096 {
                return Err("context audit too many passages".into());
            }
            let selected = selected
                .iter()
                .map(|p| passage_metadata(p, false))
                .collect::<Result<Vec<_>, _>>()?;
            let omitted = omitted
                .iter()
                .map(|p| passage_metadata(p, true))
                .collect::<Result<Vec<_>, _>>()?;
            let retrieval = match audit.get("retrieval") {
                None | Some(serde_json::Value::Null) => serde_json::Value::Null,
                Some(trace) => retrieval_trace(trace)?,
            };
            let value = serde_json::json!({"at":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?.as_millis(),"model":request.binding.model,
            "provider":request.binding.provider,"authorizationRevision":request.binding.role_snapshot.authorization_revision,
            "status":status,"messagesSha256":messages_hash,"tokenizerRevision":audit.get("tokenizerRevision"),
            "promptTokens":prompt,"contextTokens":context,"outputTokens":output,"selected":selected,"omitted":omitted,
            "retrieval":retrieval});
            let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
            let _guard = AUDIT_WRITE
                .lock()
                .map_err(|_| "context audit lock poisoned")?;
            let directory = crate::settings::settings_dir()?.join("context-packing");
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let key = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(directory.join(format!("{key}.jsonl")))
                .and_then(|mut f| {
                    f.write_all(&bytes)?;
                    f.sync_data()
                })
                .map_err(|e| e.to_string())
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capability_and_audit_reject_invalid_or_misattributed_values() {
        let mut capability = Capability {
            model: "synthetic".into(),
            context_tokens: 4096,
            output_tokens: 768,
            tokenizer_revision: "synthetic-template-v1".into(),
        };
        assert!(capability.check("synthetic").is_ok());
        assert!(capability.check("different").is_err());
        capability.output_tokens = 4096;
        assert!(capability.check("synthetic").is_err());
        let p = passage_metadata(
            &serde_json::json!({"page":"wiki/synthetic.md","section":1,
            "textSha256":format!("{:x}",Sha256::digest(b"Synthetic original.")),
            "timestamp":123,"speaker":"user","reason":"whole_passage_exceeds_allowance"}),
            true,
        )
        .unwrap();
        assert_eq!(p["reason"], "whole_passage_exceeds_allowance");
        assert!(p.get("text").is_none());
        assert_eq!(
            p["textSha256"],
            format!("{:x}", Sha256::digest(b"Synthetic original."))
        );
        assert!(passage_metadata(&serde_json::json!({"page":"wiki/missing.md"}), false).is_err());
        let trace = retrieval_trace(&serde_json::json!({"denseSkipped":"no embedding index for this vault yet",
            "hits":[{"page":"raw/conversations/synthetic.md","section":3,"scoreRrf":0.016,"scoreFinal":0.016,
                     "similarity":null,"exactMatch":true,"text":"Synthetic original."}]}))
        .unwrap();
        assert_eq!(
            trace["denseSkipped"],
            "no embedding index for this vault yet"
        );
        assert_eq!(trace["hits"][0]["section"], 3);
        assert!(trace["hits"][0].get("text").is_none());
        assert!(retrieval_trace(&serde_json::json!({"hits":[{"page":"raw/x.md"}]})).is_err());
        assert!(retrieval_trace(&serde_json::json!({"denseSkipped":1,"hits":[]})).is_err());
    }
    #[test]
    fn runtime_count_is_bound_to_selected_model_template_and_live_grant() {
        crate::settings::test_support::with_isolated_data("runtime-context-binding", |_| {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                use wiremock::{Mock, MockServer, ResponseTemplate};
                use wiremock::matchers::{method, path, body_json};
                let server = MockServer::start().await;
                let capability = serde_json::json!({"model":"synthetic-learned-model",
                    "contextTokens":4096,"outputTokens":768,"tokenizerRevision":"synthetic-template-v1"});
                Mock::given(method("GET")).and(path("/api/myco-capabilities"))
                    .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"models":[capability]})))
                    .expect(1).mount(&server).await;
                let messages = serde_json::json!([{"role":"system","content":"Grounded synthetic test only"},
                    {"role":"user","content":"Synthetic question"}]);
                Mock::given(method("POST")).and(path("/api/myco-tokenize"))
                    .and(body_json(serde_json::json!({"model":"synthetic-learned-model",
                        "messages":messages,"tokenizerRevision":"synthetic-template-v1"})))
                    .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                        "model":"synthetic-learned-model","contextTokens":4096,"outputTokens":768,
                        "tokenizerRevision":"synthetic-template-v1","promptTokens":37})))
                    .expect(1).mount(&server).await;
                let mut settings = crate::role_authorization::settings_snapshot().unwrap();
                settings.providers.ollama = true;
                settings.ollama_url = server.uri();
                crate::settings::save(&settings).unwrap();
                crate::role_authorization::select_role(crate::role_authorization::RoleSelectionRequest {
                    role:RoleId::Ask,provider_id:"ollama".into(),model_id:"synthetic-learned-model".into(),
                    effort:"(default)".into(),expected_authorization_revision:
                        crate::role_authorization::settings_snapshot().unwrap().role_authorization_revision,
                }).unwrap();
                let root = tempfile::tempdir().unwrap();
                let vault = VaultRoot::default();
                let generation = vault.begin_open().unwrap();
                vault.finish_open(generation,root.path().canonicalize().unwrap(),||()).unwrap();
                let origin = vault.snapshot().unwrap();
                let snapshot = vault.with_origin(&origin, |_| {
                    crate::role_authorization::capture_role_at(&origin,RoleId::Ask,RoleUsage::Foreground)
                        .map_err(|e|e.to_string())
                }).unwrap();
                let binding = Binding {provider:"ollama".into(),model:"synthetic-learned-model".into(),origin,role_snapshot:snapshot};
                assert_eq!(budget(&vault,&binding).await.unwrap().unwrap().context_tokens,4096);
                // This deserialization exercises the exact flat IPC request shape.
                let mut value = serde_json::to_value(&binding.role_snapshot).unwrap();
                assert!(value.is_object());
                value=serde_json::json!({"provider":binding.provider,"model":binding.model,
                    "origin":binding.origin,"roleSnapshot":binding.role_snapshot,
                    "messages":messages,"tokenizerRevision":"synthetic-template-v1"});
                let request: CountRequest = serde_json::from_value(value).unwrap();
                assert_eq!(count(&vault,&request).await.unwrap().prompt_tokens,37);
                let mut other = binding.clone(); other.model="foreign-model".into();
                assert!(budget(&vault,&other).await.unwrap_err().contains("request_route_mismatch"));
                let mut changed=crate::role_authorization::settings_snapshot().unwrap();
                changed.ollama_url="http://127.0.0.1:11435".into();
                crate::settings::save(&changed).unwrap();
                assert!(count(&vault,&request).await.is_err(),"endpoint edits must revoke previous tokenizer grants");
                assert_eq!(server.received_requests().await.unwrap().len(),2);
            });
        });
    }
}
