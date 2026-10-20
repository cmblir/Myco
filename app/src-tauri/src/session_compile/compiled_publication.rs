//! Native generated-section authority. Public model JSON/marker/hash fields do
//! not confer ownership. Restart permits retain only native section custody.

use super::super::compiler::NativeCompilation;
use super::super::state::NativeOutput;
use super::super::{bound_path, identity, now, Grant, SessionCompileContext};
use crate::importers::wikify::{source_revision, Pending};
use crate::vault::RecordedWriteReceipt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[path = "compiled_custody.rs"]
mod custody;

const RESERVED: &str = "<!-- myco:session-compilation";
const START: &str = "<!-- myco:session-compilation:v1 ";
const END: &str = "<!-- /myco:session-compilation -->";

/// This private capability is returned only after a real recorded native write.
/// No Serialize/Deserialize: neither hashes nor a forged marker can recreate it.
pub(in crate::session_compile) struct NativeSectionAuthority {
    ownership: SectionOwnership,
    artifact_revision: String,
    receipt: RecordedWriteReceipt,
    queue_error: Option<String>,
    retirement: custody::RetirementDiagnostic,
}

/// A section boundary/provenance view is data, never compilation or completion.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::session_compile) struct SectionOwnership {
    session_key: String,
    path: String,
    marker: String,
    section_revision: String,
    #[serde(deserialize_with = "unique_owned_fields")]
    owned_fields: BTreeMap<String, serde_json::Value>,
    display_title: Option<String>,
}

fn unique_owned_fields<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<BTreeMap<String, serde_json::Value>, D::Error> {
    struct Unique;
    impl<'de> serde::de::Visitor<'de> for Unique {
        type Value = BTreeMap<String, serde_json::Value>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("unique compiler owned-field keys")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut values = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, serde_json::Value>()? {
                if values.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom(
                        "duplicate compiler owned-field key",
                    ));
                }
            }
            Ok(values)
        }
    }
    decoder.deserialize_map(Unique)
}

impl std::ops::Deref for NativeSectionAuthority {
    type Target = SectionOwnership;
    fn deref(&self) -> &Self::Target {
        &self.ownership
    }
}

impl NativeSectionAuthority {
    pub(in crate::session_compile) fn publication_error(&self) -> Option<&str> {
        self.queue_error.as_deref()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    session_key: String,
    source_revision: String,
    compile_signature: String,
    artifact_revision: String,
    nonce: String,
}

struct PreparedSummary {
    content: String,
    owned_fields: BTreeMap<String, serde_json::Value>,
    display_title: Option<String>,
    preservation: Option<PreservedPriorImage>,
}

// Only refreshed_content can mint this image-preservation witness. It is not
// serialized and conveys no compilation, role or canonical deletion authority.
struct PreservedPriorImage {
    consumed_prior_sha256: String,
    successor_sha256: String,
}

fn json_string(text: &str) -> Result<String, String> {
    serde_json::to_string(text).map_err(|error| error.to_string())
}

fn markdown(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('*', "\\*")
        .replace('_', "\\_")
        .replace('`', "\\`")
}

fn generated_title(compilation: &NativeCompilation) -> String {
    compilation
        .packets()
        .iter()
        .find_map(|packet| {
            let view = packet.compilation.as_view();
            (!view.title.is_empty()).then(|| view.title.clone())
        })
        .unwrap_or_else(|| match compilation.language() {
            "ko" => "세션 정리".into(),
            "ja" => "セッション整理".into(),
            _ => "Session summary".into(),
        })
}

fn generated_body(compilation: &NativeCompilation, raw_path: &str) -> Result<String, String> {
    if raw_path.contains(['[', ']', '|', '\r', '\n', '\0']) {
        return Err("native original reference cannot be rendered safely".into());
    }
    let mut text = format!("## {}\n\n", markdown(&generated_title(compilation)));
    // Keep the exact reviewed app rows in original order. This is not a new
    // global synthesis or independently verified project/status aggregation.
    for packet in compilation.packets() {
        for (summary, claim) in packet
            .compilation
            .as_view()
            .summaries
            .iter()
            .zip(&packet.claims)
        {
            let proposal = &claim.claim.proposal;
            text.push_str(&format!(
                "- {} [^mx-{}]\n",
                markdown(&summary.text),
                claim.id
            ));
            let coordinates: Vec<_> = claim
                .claim
                .provenance
                .iter()
                .map(|span| {
                    let mut value =
                        serde_json::to_value(span).map_err(|error| error.to_string())?;
                    value
                        .as_object_mut()
                        .ok_or("source span is not an object")?
                        .remove("text");
                    Ok::<_, String>(value)
                })
                .collect::<Result<_, _>>()?;
            text.push_str(&format!(
                "  <!-- myco:claim-metadata {} -->\n",
                serde_json::json!({"actor":proposal.actor,"eventTime":proposal.event_time,
                    "speechAct":proposal.speech_act,"status":proposal.status,
                    "sourceSpans":coordinates,"independentVerification":false})
                .to_string()
                .replace('<', "\\u003c")
                .replace('>', "\\u003e")
                .replace('&', "\\u0026")
            ));
        }
    }
    text.push('\n');
    for packet in compilation.packets() {
        for claim in &packet.claims {
            // The original reference is app-owned; no model citation or caller
            // source replacement can supply this line.
            text.push_str(&format!("[^mx-{}]: {}\n", claim.id, raw_path));
        }
    }
    if compilation
        .packets()
        .iter()
        .all(|packet| packet.claims.is_empty())
    {
        text.push_str(&format!("[^mx-source]: {raw_path}\n\n[^mx-source]\n"));
    }
    Ok(text)
}

fn marker(
    compilation: &NativeCompilation,
    context: &SessionCompileContext,
) -> Result<String, String> {
    let value = Marker {
        session_key: context.source.key.clone(),
        source_revision: compilation.source_revision().into(),
        compile_signature: compilation.signature().into(),
        artifact_revision: compilation.revision()?,
        nonce: super::super::nonce()?,
    };
    let encoded = serde_json::to_string(&value)
        .map_err(|error| error.to_string())?
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    if encoded.len() > 16 * 1024 {
        return Err("compiled section marker exceeds bounds".into());
    }
    Ok(format!("{START}{encoded} -->\n"))
}

fn range(current: &str, proof: &SectionOwnership) -> Result<(usize, usize), String> {
    if current.matches(RESERVED).count() != 1 || current.matches(END).count() != 1 {
        return Err("compiler section ownership is missing or ambiguous; preserve draft".into());
    }
    let start = current
        .find(&proof.marker)
        .ok_or("native compiler marker changed; preserve human edits")?;
    let body = start + proof.marker.len();
    let end = current[body..]
        .find(END)
        .map(|offset| body + offset + END.len())
        .ok_or("native compiler section closing marker changed")?;
    let end = end + usize::from(current[end..].starts_with('\n'));
    if source_revision(&current[start..end]) != proof.section_revision {
        return Err("native generated section was edited; preserve draft and human content".into());
    }
    Ok((start, end))
}

fn frontmatter_end(text: &str) -> Result<usize, String> {
    let rest = text
        .strip_prefix("---\n")
        .ok_or("existing session summary lacks frontmatter")?;
    rest.find("\n---\n")
        .map(|end| 4 + end + 5)
        .ok_or("existing summary frontmatter is unterminated".into())
}

// Replace only the exact previous native scalar value, retaining trailing YAML
// comments/spacing. Edited or differently formatted provenance stays a conflict.
fn replace_field(
    prefix: &str,
    field: &str,
    old: &serde_json::Value,
    new: &serde_json::Value,
) -> Result<String, String> {
    let native = format!("{field}: {old}");
    let replacement = format!("{field}: {new}");
    let mut found = 0;
    let mut result = String::new();
    for line in prefix.split_inclusive('\n') {
        if let Some(suffix) = line.strip_prefix(&native) {
            if !(suffix.trim().is_empty() || suffix.trim_start().starts_with('#')) {
                return Err("native frontmatter scalar was edited; preserve draft".into());
            }
            found += 1;
            result.push_str(&replacement);
            result.push_str(suffix);
        } else {
            result.push_str(line);
        }
    }
    if found != 1 {
        return Err("native frontmatter ownership changed or is ambiguous".into());
    }
    Ok(result)
}

fn refreshed_content(
    old: &str,
    section: &str,
    context: &SessionCompileContext,
    title: &str,
    proof: &SectionOwnership,
) -> Result<PreparedSummary, String> {
    let metadata = super::parse(old)?.0;
    if metadata["session_key"].as_str() != Some(context.source.key.as_str()) {
        return Err("compiled canonical page has a different session identity".into());
    }
    if !proof.owned_fields.contains_key("raw_path")
        && metadata
            .get("raw_path")
            .is_some_and(|path| path.as_str() != Some(context.source.raw_path.as_str()))
    {
        return Err("unowned original lineage changed; preserve legacy page and draft".into());
    }
    let (start, end) = range(old, proof)?;
    let fm_end = frontmatter_end(old)?;
    if start < fm_end {
        return Err("compiled section appears inside metadata".into());
    }
    let mut prefix = old[..fm_end].to_string();
    let mut fields = proof.owned_fields.clone();
    let mut display_title = None;
    for (field, value) in &proof.owned_fields {
        if metadata.get(field) != Some(value) {
            return Err(
                "generated provenance was edited; preserve source and human content".into(),
            );
        }
        let next = match field.as_str() {
            "raw_path" => serde_json::json!(context.source.raw_path),
            "session_revision" => serde_json::json!(context.source.source_revision),
            "session_generated_title" => serde_json::json!(title),
            "derived_from" => {
                let mut sources = value
                    .as_array()
                    .ok_or("native derived lineage is invalid")?
                    .clone();
                let source = serde_json::json!(context.source.raw_path);
                if !sources.contains(&source) {
                    sources.push(source);
                }
                serde_json::Value::Array(sources)
            }
            _ => value.clone(),
        };
        prefix = replace_field(&prefix, field, value, &next)?;
        fields.insert(field.clone(), next);
    }
    let mut body_prefix = old[fm_end..start].to_string();
    if let Some(before) = &proof.display_title {
        if metadata["title"].as_str() == Some(before.as_str()) {
            prefix = replace_field(
                &prefix,
                "title",
                &serde_json::json!(before),
                &serde_json::json!(title),
            )?;
            let heading = format!("# {}\n", markdown(before));
            let rest = body_prefix
                .strip_prefix(&heading)
                .ok_or("generated heading changed; preserve human edit and draft")?;
            body_prefix = format!("# {}\n{rest}", markdown(title));
            display_title = Some(title.into());
        }
    }
    let content = format!("{prefix}{body_prefix}{section}{}", &old[end..]);
    let preservation = PreservedPriorImage {
        consumed_prior_sha256: source_revision(old),
        successor_sha256: source_revision(&content),
    };
    Ok(PreparedSummary {
        content,
        owned_fields: fields,
        display_title,
        preservation: Some(preservation),
    })
}

fn initial_content(
    old: Option<&str>,
    section: &str,
    context: &SessionCompileContext,
    title: &str,
) -> Result<PreparedSummary, String> {
    match old {
        Some(old) => {
            let metadata = super::parse(old)?.0;
            if metadata["session_key"].as_str() != Some(context.source.key.as_str())
                || old.contains(RESERVED)
                || old.contains(END)
                || metadata
                    .get("raw_path")
                    .is_some_and(|path| path.as_str() != Some(context.source.raw_path.as_str()))
            {
                return Err(
                    "existing summary ownership or original lineage is unresolved; preserve draft"
                        .into(),
                );
            }
            // Preserve every legacy/human byte. The new section gains only its
            // own native capability; no legacy title/frontmatter is claimed.
            Ok(PreparedSummary {
                content: format!("{old}\n{section}"),
                owned_fields: BTreeMap::new(),
                display_title: None,
                preservation: None,
            })
        }
        None => {
            let fields = BTreeMap::from([
                ("session_key".into(), serde_json::json!(context.source.key)),
                (
                    "raw_path".into(),
                    serde_json::json!(context.source.raw_path),
                ),
                (
                    "session_revision".into(),
                    serde_json::json!(context.source.source_revision),
                ),
                ("session_generated_title".into(), serde_json::json!(title)),
                (
                    "derived_from".into(),
                    serde_json::json!([context.source.raw_path]),
                ),
            ]);
            let mut text = format!(
                "---\ntype: source-summary\ntitle: {}\n",
                json_string(title)?
            );
            for (key, value) in &fields {
                text.push_str(&format!("{key}: {value}\n"));
            }
            text.push_str(&format!("---\n# {}\n\n{section}", markdown(title)));
            Ok(PreparedSummary {
                content: text,
                owned_fields: fields,
                display_title: Some(title.into()),
                preservation: None,
            })
        }
    }
}

pub(in crate::session_compile) fn publish_compiled(
    root: &Path,
    pending: &mut Pending,
    grant: &mut Grant,
    compilation: &NativeCompilation,
    previous: Option<&NativeSectionAuthority>,
) -> Result<NativeSectionAuthority, String> {
    let context = grant.context.clone();
    if compilation.attempt_id() != context.attempt_id
        || compilation.signature() != context.compile_signature
        || compilation.source_revision() != context.source.source_revision
    {
        return Err("native compilation belongs to a different issued source/attempt".into());
    }
    let path = bound_path(root, &context.summary_path)?;
    let mut store = custody::Store::open(root, &context)?;
    let prior = {
        let guard = crate::vault::lock_file_mutation()?;
        store.prior_locked(&guard, previous)?
    };
    let current = {
        let guard = crate::vault::lock_file_mutation()?;
        match &prior {
            Some(prior) => {
                Some(crate::vault::read_compiler_prior_file_pin_locked(&guard, &prior.pin)?.0)
            }
            None => custody::read_initial(&path)?,
        }
    };
    let marker = marker(compilation, &context)?;
    let section = format!(
        "{marker}{}{END}\n",
        generated_body(compilation, &context.source.raw_path)?
    );
    let title = generated_title(compilation);
    let prepare = |current: Option<&str>| match (&prior, current) {
        (Some(prior), Some(old)) => {
            refreshed_content(old, &section, &context, &title, &prior.ownership)
        }
        (None, old) => initial_content(old, &section, &context, &title),
        _ => Err("native compiler section custody lost its canonical page".into()),
    };
    let prepared = prepare(current.as_deref())?;
    if prepared.content.len() > 4 * 1024 * 1024 || prepared.content.contains('\0') {
        return Err(
            "native compiled page exceeds bounded publication budget; remains partial".into(),
        );
    }
    let ownership = SectionOwnership {
        session_key: context.source.key.clone(),
        path: context.summary_path.clone(),
        marker,
        section_revision: source_revision(&section),
        owned_fields: prepared.owned_fields,
        display_title: prepared.display_title,
    };
    let expected = current.as_deref().map(source_revision);
    let mut retirement = custody::RetirementDiagnostic::complete();
    let persisted = super::persist_recorded_with_writer(
        root,
        pending,
        grant,
        &context.summary_path,
        &prepared.content,
        expected.as_deref(),
        |path, content, expected| {
            let guard = crate::vault::lock_file_mutation()?;
            // Initial human-page capture is physical CAS only, after the exact
            // existing no-marker/session/lineage checks above. It cannot enroll
            // an already marked page or manufacture a prior section permit.
            let initial = if prior.is_none() && expected.is_some() {
                Some(crate::vault::capture_compiler_initial_file_pin_locked(
                    &guard, path,
                )?)
            } else {
                None
            };
            let pin = prior.as_ref().map(|prior| &prior.pin).or(initial.as_ref());
            let captured = pin
                .map(|pin| crate::vault::read_compiler_prior_file_pin_locked(&guard, pin))
                .transpose()?;
            if captured.as_ref().map(|(_, sha)| sha.as_str()) != expected {
                return Err("compiler canonical changed before held-custody publication".into());
            }
            let rechecked = prepare(captured.as_ref().map(|(text, _)| text.as_str()))?;
            if rechecked.content != content {
                return Err(
                    "compiler canonical preservation view changed before publication".into(),
                );
            }
            let published = store.publish_locked(
                &guard,
                compilation,
                &ownership,
                path,
                content,
                pin,
                expected,
                rechecked.preservation.as_ref(),
            )?;
            retirement = published.retirement;
            Ok(published.receipt)
        },
    )?;
    let receipt = persisted.receipt;
    if persisted.queue_error.is_none() {
        grant
            .outputs
            .insert(context.summary_path.clone(), receipt.clone());
    }
    Ok(NativeSectionAuthority {
        ownership,
        artifact_revision: compilation.revision()?,
        receipt,
        queue_error: persisted.queue_error,
        retirement,
    })
}

/// Check the retained runtime artifact and actual persisted outputs without
/// changing the queue. The caller selects the locking or writer-held verifier.
pub(in crate::session_compile) fn verify_compiled(
    root: &Path,
    grant: &Grant,
    compilation: &NativeCompilation,
    proof: &NativeSectionAuthority,
    outputs: &[NativeOutput],
    verify_receipt: impl Fn(&RecordedWriteReceipt) -> Result<(), String>,
) -> Result<(), String> {
    let context = &grant.context;
    if let Some(error) = &proof.queue_error {
        return Err(error.clone());
    }
    if compilation.attempt_id() != context.attempt_id
        || compilation.signature() != context.compile_signature
        || compilation.source_revision() != context.source.source_revision
        || proof.artifact_revision != compilation.revision()?
        || proof.session_key != context.source.key
        || proof.path != context.summary_path
    {
        return Err(
            "compiler completion lacks its current native artifact/section authority".into(),
        );
    }
    let actual = grant
        .outputs
        .get(&context.summary_path)
        .ok_or("compiler completion lacks native publication")?;
    if !actual.same_native_issuance(&proof.receipt)
        || actual.revision != proof.receipt.revision
        || actual.path != proof.receipt.path
        || actual.file_identity != proof.receipt.file_identity
        || actual.native_created != proof.receipt.native_created
    {
        return Err("compiled native output changed".into());
    }
    verify_receipt(actual)?;
    let current = std::fs::read_to_string(bound_path(root, &context.summary_path)?)
        .map_err(|error| format!("read native compiled summary: {error}"))?;
    range(&current, proof)?;
    if !outputs
        .iter()
        .any(|output| output.path == context.summary_path)
    {
        return Err("compiler completion lacks its durable summary output".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    for output in outputs {
        super::allowed(context, &output.path, true)?;
        let native = grant
            .outputs
            .get(&output.path)
            .ok_or("compiler output lacks native runtime authority")?;
        if output.attempt_id != context.attempt_id
            || output.publication_id.is_empty()
            || !seen.insert(&output.path)
            || native.path != bound_path(root, &output.path)?
            || native.revision != output.revision
            || native.native_created != output.native_created
            || serde_json::to_value(&native.file_identity).map_err(|error| error.to_string())?
                != output.identity
        {
            return Err("compiler output differs from its native publication receipt".into());
        }
        verify_receipt(native)?;
    }
    Ok(())
}

pub(in crate::session_compile) fn finish_compiled(
    root: &Path,
    pending: &mut Pending,
    grant: &mut Grant,
    compilation: &NativeCompilation,
    proof: &NativeSectionAuthority,
) -> Result<serde_json::Value, String> {
    let context = &grant.context;
    let job = pending
        .compile_jobs
        .iter_mut()
        .find(|job| job.id == context.job_id)
        .ok_or("compiler job no longer admitted")?;
    let outputs: Vec<NativeOutput> = job
        .active(
            &context.attempt_id,
            &context.origin,
            &context.role_snapshot.snapshot_id,
            &identity(context),
        )?
        .outputs
        .clone();
    verify_compiled(
        root,
        grant,
        compilation,
        proof,
        &outputs,
        crate::vault::verify_recorded_file,
    )?;
    let checks = compilation.checks();
    let complete = job.finish(&context.attempt_id, checks.clone(), outputs, now())?;
    if complete
        && pending
            .pending
            .iter()
            .any(|item| item.key == context.source.key)
    {
        // Only the actual source-bound native compilation/publication closes
        // this reminder. A legacy reminder receipt still cannot complete jobs.
        pending.complete(crate::importers::wikify::Receipt {
            key: context.source.key.clone(),
            raw_path: context.source.raw_path.clone(),
            source_revision: context.source.source_revision.clone(),
            wiki_paths: vec![context.summary_path.clone()],
            completed: crate::registry::today_utc(),
        })?;
    }
    pending.save(root)?;
    Ok(
        serde_json::json!({"ok":complete,"state":if complete{"completed"}else{"partial"},
        "attemptId":context.attempt_id,"checks":checks,"internalReview":"automated_same_route",
        "independentVerification":false,"releaseGroundTruth":false,"custodyRetirement":proof.retirement}),
    )
}

#[cfg(test)]
#[path = "compiled_publication_tests.rs"]
mod tests;

#[cfg(all(test, unix))]
#[path = "compiled_custody_tests.rs"]
mod custody_tests;

// Opening/role/source/request guards belong to the caller. This maintenance
// performs no inference and releases STORE/FILE before failure finalization.
pub(in crate::session_compile) fn maintain_custody(
    root: &Path,
    context: &SessionCompileContext,
) -> Result<custody::RetirementDiagnostic, String> {
    let mut store = custody::Store::open(root, context)?;
    let guard = crate::vault::lock_file_mutation()?;
    store.maintain_retirement_locked(&guard, 3)
}
