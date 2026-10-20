//! QA-only source quotation replay; no native or product publication authority.

#[path = "local_quoted_packet_probe/contract.rs"]
mod contract;
#[path = "local_packet_probe/contract.rs"]
#[allow(dead_code)]
mod original_contract;
#[path = "local_quoted_packet_probe/replay.rs"]
mod replay;

fn main() {
    let result = contract::options(std::env::args().skip(1)).and_then(replay::run);
    println!(
        "{}",
        serde_json::json!({"phase":"quoted_replay_terminal","error":result.as_ref().err(),
        "nativeIoAuthenticated":false,"productRoleAuthorized":false,
        "semanticAccepted":false,"productionAccepted":false,
        "plannerRecallReviewIpcInstalled":"not_run"})
    );
    if result.is_err() {
        std::process::exit(1);
    }
}
