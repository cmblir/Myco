//! Synthetic-only retrieval ablation. No vault, network, or index writes.
//! Run: `cargo run --release --example local_search_probe`.

use std::path::PathBuf;
use std::time::Instant;

use myco_lib::{
    local_llm::{embed_spec_by_id, EmbedRole, LocalLlm, BUILTIN_EMBED_MODEL},
    retrieval::{apply_tier_prior, cap_per_page, rrf_fuse, Bm25Index, TierWeights},
    vector_index::{Hit, VectorStore},
};

const DOCUMENTS: &[(&str, &str)] = &[
    ("wiki/search.md", "검색 임베딩은 한국어 E5-small이다. 벡터 검색과 BM25 키워드 검색을 RRF로 결합한다. Qwen은 답변 생성용이며 임베딩 모델이 아니다."),
    ("wiki/memory.md", "지원 목표에는 Intel Mac과 메모리 8GB가 포함된다. 이 기기의 실제 성능은 아직 측정하지 않았다. 모델은 필요할 때만 로드하고 유휴 상태에서 해제한다."),
    ("wiki/mail.md", "synthetic-mail 커넥터는 Gmail과 iCloud Mail 자료를 읽기 전용으로 가져오는 계획이다. 아직 구현 완료나 실계정 검증 기록은 없다."),
    ("wiki/iphone.md", "iPhone 앱은 사용자가 허용한 연락처와 캘린더를 가져올 수 있다. 기존 SMS 전체 기록을 읽는 공개 API는 없다. 사용자가 내보낸 파일의 수동 가져오기는 별도 경로다."),
    ("wiki/cancellation.md", "사용자가 중단하면 해당 생성 요청 ID만 취소한다. 취소된 미리보기 결과는 저장하지 않는다. 다른 작업의 취소 상태는 유지한다."),
    ("wiki/pins.md", "모델 아티팩트 SYN-42Z는 파일 크기와 SHA-256을 검증한다. 리비전과 HTTPS 다운로드 주소를 고정한다. 검증 실패는 ready로 표시하지 않는다."),
    ("wiki/evidence.md", "원문 근거는 raw에 보존한다. 요약은 원문을 대체하지 않는다. 생성 전에 읽은 파일이 바뀌면 미리보기와 저장을 중단한다."),
    ("wiki/decision.md", "2026-10-01 Gemma 후보를 검토했다. 2026-10-05 그 후보를 철회하고 Qwen을 선택했다. 이전 검토가 최종 결정은 아니다."),
    ("wiki/contention.md", "색인과 답변 생성은 CPU와 메모리를 공유한다. 생성이 실행 중일 때 새로운 백그라운드 색인 배치를 잠시 미룬다."),
    ("wiki/status.md", "2026-10-02 테스트를 완료했다고 보고했다. 2026-10-05 회귀가 발견되어 구현을 롤백했다. 현재 상태는 미완료다."),
    ("sessions/synthetic-request.md", "User: 내가 확인하면 되는 거 알려줘. Assistant: 브라우저에서 서로 연결되는 아이디어가 있어? 질문을 검증할 계획입니다."),
    ("sessions/synthetic-noise.md", "Assistant: 새 버튼의 배경색을 조정할 계획입니다. User: 사이드바 위치를 바꿔줘."),
];

const QUESTIONS: &[(&str, &str)] = &[
    (
        "임베딩 모델은 무엇이고 검색 결과를 어떻게 합쳐?",
        "wiki/search.md",
    ),
    (
        "문장이 달라도 자료를 찾고 정확한 단어도 놓치지 않으려면?",
        "wiki/search.md",
    ),
    ("작은 메모리의 인텔 컴퓨터도 지원 목표야?", "wiki/memory.md"),
    ("메일 연동은 끝났어?", "wiki/mail.md"),
    ("아이폰 문자 기록을 직접 읽을 수 있어?", "wiki/iphone.md"),
    (
        "중단 버튼을 누른 뒤 늦게 온 결과는 저장돼?",
        "wiki/cancellation.md",
    ),
    ("SYN-42Z", "wiki/pins.md"),
    ("SHA-256 검증", "wiki/pins.md"),
    ("생성하는 동안 자료가 수정되면?", "wiki/evidence.md"),
    ("Gemma를 최종 선택했어?", "wiki/decision.md"),
    ("답변할 때 색인을 기다리게 하는 이유", "wiki/contention.md"),
    ("롤백 후 지금 작업 상태", "wiki/status.md"),
];

fn rank(hits: &[Hit], expected: &str) -> Option<usize> {
    hits.iter()
        .position(|hit| hit.page == expected)
        .map(|index| index + 1)
}

fn main() -> Result<(), String> {
    let spec = embed_spec_by_id(BUILTIN_EMBED_MODEL).ok_or("missing embedding spec")?;
    let model_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(spec.file);
    let mut llm = LocalLlm::load_embed_host()?;
    let started = Instant::now();
    llm.ensure_embed_model(&model_path)?;
    let load_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut store = VectorStore::default();
    store.ensure_model(BUILTIN_EMBED_MODEL);
    let mut lexical = Bm25Index::new();
    let started = Instant::now();
    for (page, text) in DOCUMENTS {
        let vector = llm
            .embed_spec(spec, EmbedRole::Document, &[text.to_string()])?
            .pop()
            .ok_or("missing document embedding")?;
        store.upsert_page(page, page, vec![(0, vector)])?;
        lexical.upsert_page(page, page, &[text.to_string()]);
    }
    println!(
        "{}",
        serde_json::json!({"phase":"index", "model":spec.id,
        "load_ms":load_ms, "index_ms":started.elapsed().as_secs_f64()*1000.0,
        "documents":DOCUMENTS.len(), "bytes":std::fs::metadata(&model_path).map_err(|e|e.to_string())?.len()})
    );
    let mut counts = [[0usize; 2]; 3];
    for (question, expected) in QUESTIONS {
        let started = Instant::now();
        let vector = llm
            .embed_spec(spec, EmbedRole::Query, &[question.to_string()])?
            .pop()
            .ok_or("missing query embedding")?;
        let dense = store.search(&vector, 20)?;
        let lexical_hits = lexical.search(question, 20);
        let lexical_rank = lexical_hits
            .iter()
            .position(|hit| hit.page == *expected)
            .map(|index| index + 1);
        let mut fused = rrf_fuse(&dense, &lexical_hits, 20);
        apply_tier_prior(&mut fused, &TierWeights::default());
        let hybrid = cap_per_page(fused, 2, 12);
        let ranks = [
            rank(&dense, expected),
            lexical_rank,
            rank(&hybrid, expected),
        ];
        for (count, position) in counts.iter_mut().zip(ranks) {
            count[0] += usize::from(position == Some(1));
            count[1] += usize::from(position.is_some_and(|p| p <= 3));
        }
        println!(
            "{}",
            serde_json::json!({"phase":"query", "question":question,
            "expected":expected, "ranks_dense_bm25_hybrid":ranks,
            "top_cosine":dense.first().map(|hit|hit.score),
            "query_ms":started.elapsed().as_secs_f64()*1000.0})
        );
    }
    println!(
        "{}",
        serde_json::json!({"phase":"summary", "queries":QUESTIONS.len(),
        "top1_top3_dense_bm25_hybrid":counts, "synthetic_only":true,
        "note":"Small development ablation; no general accuracy or abstention calibration claim."})
    );
    Ok(())
}
