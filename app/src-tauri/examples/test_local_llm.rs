//! E2E check for the embedded local model: loads the bundled GGUF through the
//! app's own local_llm module and runs a KO classification + a short query.
//! Run: cargo run --example test_local_llm --release
use std::path::PathBuf;

fn main() {
    let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models/gemma-3-1b-it-q4_k_m.gguf");
    println!("loading {} …", model.display());
    let llm = memex_lib::local_llm::LocalLlm::load(&model).expect("load");

    let t0 = std::time::Instant::now();
    let label = llm
        .classify("어텐션 메커니즘은 트랜스포머에서 토큰 간 관계를 계산하는 기법이다.")
        .expect("classify");
    println!("CLASSIFY(ko) -> {label}  ({:.1}s)", t0.elapsed().as_secs_f32());
    assert!(memex_lib::local_llm::WIKI_TYPES.contains(&label.as_str()));

    let t1 = std::time::Instant::now();
    let out = llm
        .generate("한 문장으로 답해. 위키란 무엇인가?", 80)
        .expect("generate");
    println!("QUERY(ko) -> {out:?}  ({:.1}s)", t1.elapsed().as_secs_f32());
    assert!(!out.trim().is_empty());

    // Repro of the degenerate-repetition report: vault-ish context + a vague
    // meta question used to loop one sentence until the token cap.
    let ctx = "## log.md\n2026-07-01 ingest | Attention Is All You Need\n2026-07-02 query | RLHF 정리\n2026-07-03 ingest | Scaling Laws\n";
    let t3 = std::time::Instant::now();
    let rep = llm
        .generate(&format!("{ctx}\n내가 최근한 일이 뭐야?"), 320)
        .expect("repetition repro");
    println!("REPRO -> {rep:?}  ({:.1}s)", t3.elapsed().as_secs_f32());
    // A degenerate loop repeats one clause many times; assert it doesn't.
    let tail: String = rep.chars().rev().take(24).collect::<Vec<_>>().into_iter().rev().collect();
    assert!(tail.trim().is_empty() || rep.matches(&tail).count() < 3, "looping output");

    // Regression: a prompt far beyond 512 tokens (inlined vault context) used
    // to crash with "batch.add: Insufficient Space of 512".
    let filler = "지식 그래프는 노트 사이의 연결을 보여준다. ".repeat(400);
    let long_prompt = format!("{filler}\n\n위 내용과 관련해 한 문장으로: 위키의 장점은?");
    let t2 = std::time::Instant::now();
    let out2 = llm.generate(&long_prompt, 60).expect("long-context generate");
    println!(
        "LONG(ctx≈{} chars) -> {:?}  ({:.1}s)",
        long_prompt.len(),
        out2,
        t2.elapsed().as_secs_f32()
    );
    assert!(!out2.trim().is_empty());
    println!("OK");
}
