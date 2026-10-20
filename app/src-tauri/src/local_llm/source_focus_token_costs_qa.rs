//! Actual tokenizer counts over recorded synthetic QA packets; no inference.
use super::*;
use sha2::{Digest, Sha256};

fn sha(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

pub(super) fn observe(host: &LocalLlm, model: &LlamaModel) {
    let Some(path) = std::env::var_os("MYCO_QA_FOCUS_TOKEN_PACKET_PATH") else {
        return;
    };
    let path = PathBuf::from(path);
    assert!(path.is_absolute());
    assert!(std::fs::symlink_metadata(&path)
        .unwrap()
        .file_type()
        .is_file());
    let bytes = std::fs::read(&path).unwrap();
    let controls: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        controls["version"],
        "HistoricalNativePacketTokenizerOnlyControlsV1"
    );
    assert_eq!(controls["goldInModelInputs"], false);
    for record in controls["packets"].as_array().unwrap() {
        let raw = record["rawUser"].as_str().unwrap();
        assert_eq!(sha(raw), record["packetSha256"]);
        let claims = record["priorUnapprovedClaims"].as_array().unwrap();
        let mut costs = Vec::new();
        for encoding in [Encoding::TupleV1, Encoding::NamedV1] {
            let packet = PreparedFocusQa::prepare_for(raw, encoding).unwrap();
            assert_eq!(packet.original_user(), raw);
            assert_eq!(packet.decoder().packet_sha256(), sha(raw));
            let prompt_tokens = host
                .chat_token_count(packet.system(), packet.user())
                .unwrap();
            let control = output(&packet, "claims", claims);
            let output_tokens = model.str_to_token(&control, AddBos::Never).unwrap().len();
            costs.push(json!({"wireVersion":packet.decoder().wire_version(),
                "systemSha256":sha(packet.system()),"userSha256":sha(packet.user()),
                "promptTokens":prompt_tokens,"promptFits3320":prompt_tokens<=3320,
                "canonicalControlSha256":sha(&control),"canonicalControlBytes":control.len(),
                "canonicalControlBodyTokens":output_tokens,"canonicalControlBodyFits768":output_tokens<=768,
                "bodyPlusOneEogTokenReference":output_tokens+1,"bodyPlusOneEogReferenceFits768":output_tokens<768,
                "actualGenerationFitProven":false,"tokenReferenceIncludesActualSampling":false}));
        }
        println!(
            "{}",
            json!({"phase":"source_focus_recorded_packet_token_costs",
            "requestId":record["requestId"],"historicalOrdinal":record["generationOrdinal"],
            "packetSha256":sha(raw),"controlsFileSha256":format!("{:x}",Sha256::digest(&bytes)),
            "encodings":costs,"historicalPacket":true,"futureServedPacketIdentityProven":false,
            "priorProposalsUnapproved":true,"modelContextCreated":false,"forwardInference":false,
            "semanticAcceptance":false,"modelQualityAcceptance":false})
        );
    }
}
