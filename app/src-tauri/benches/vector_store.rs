//! Baseline benchmarks for the semantic layer's vector store.
//!
//! Pure CPU — no GGUF, no Metal, no model load — so these numbers are stable and
//! reproducible on any machine. They exist to justify (or kill) four proposed
//! optimizations before any of them ship:
//!
//! 1. `store_load` — how much per-call JSON reparse actually costs (motivates an
//!    in-memory cache).
//! 2. `serialize` — JSON vs a raw-f32 binary format, encode and decode.
//! 3. `similarity` — full `cosine` vs a dot-product fast path for vectors that
//!    are already L2-normalized at write time.
//! 4. `edges` — the shipped page-centroid `semantic_edges` against the
//!    best-chunk-vs-best-chunk shape it replaced.
//!
//! Candidates are written here first so a proposal is measured before it ships;
//! once one lands in `vector_index.rs` the candidate is deleted and the bench
//! re-pointed at the real code. All four have now shipped, so each bench pits
//! the real implementation against the baseline it replaced.
//!
//! Run: `cargo bench --bench vector_store`

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use memex_lib::embeddings::{cosine, dot, normalize};
use memex_lib::vector_index::{Record, VectorStore};

/// Embedding width of the bundled Gemma 3 1B — the geometry the real index uses.
const DIM: usize = 1152;
/// Chunks per page in a typical wiki vault, from the karpathy vault's shape.
const CHUNKS_PER_PAGE: usize = 3;

// ---------------------------------------------------------------------------
// Deterministic synthetic fixtures (no `rand` dependency — a xorshift is plenty
// for filling vectors with incompressible, non-degenerate floats).
// ---------------------------------------------------------------------------

struct Xorshift(u64);

impl Xorshift {
    fn next_f32(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        // Map to [-1, 1) — real embedding components straddle zero.
        (self.0 >> 40) as f32 / 8_388_608.0 - 1.0
    }
}

fn synth_vector(rng: &mut Xorshift) -> Vec<f32> {
    let mut v: Vec<f32> = (0..DIM).map(|_| rng.next_f32()).collect();
    // The real pipeline stores L2-normalized vectors; match it so the
    // dot-product fast path is measured against honest inputs.
    normalize(&mut v);
    v
}

/// A store of `records` chunks spread over `records / CHUNKS_PER_PAGE` pages,
/// shaped like a real index (`wiki/<n>.md`, section 0..CHUNKS_PER_PAGE).
fn synth_store(records: usize) -> VectorStore {
    let mut rng = Xorshift(0x9E3779B97F4A7C15);
    let mut store = VectorStore {
        model: "builtin-local:".into(),
        dim: DIM,
        records: Vec::with_capacity(records),
    };
    for i in 0..records {
        let page_no = i / CHUNKS_PER_PAGE;
        let section = i % CHUNKS_PER_PAGE;
        let page = format!("wiki/page-{page_no}.md");
        store.records.push(Record {
            id: format!("{page}#{section}"),
            stem: format!("page-{page_no}"),
            page,
            section,
            hash: i as u64,
            vector: synth_vector(&mut rng),
        });
    }
    store
}

/// The pre-centroid shape of `semantic_edges`: every page against every other,
/// best chunk vs best chunk. Kept as the baseline the shipped `centroid_edges`
/// is measured against — `related` itself still works this way for the Reader's
/// related-notes panel.
fn edges_best_chunk(store: &VectorStore, k: usize) -> usize {
    let pages: std::collections::HashSet<&str> =
        store.records.iter().map(|r| r.page.as_str()).collect();
    let mut count = 0;
    for page in &pages {
        count += store.related(page, k).len();
    }
    count
}

// ---------------------------------------------------------------------------
// Benches
// ---------------------------------------------------------------------------

/// Per-call deserialization cost — this is what an in-memory cache (B2) deletes.
/// Also prints on-disk size for JSON vs binary, which Criterion itself can't report.
fn bench_store_load(c: &mut Criterion) {
    let mut group = c.benchmark_group("store_load");
    group.sample_size(20);
    for &n in &[1_000usize, 5_000, 10_000] {
        let store = synth_store(n);
        let json = serde_json::to_vec(&store).unwrap();
        let bin = store.encode();
        eprintln!(
            "[size] {n:>6} records x {DIM}d -> json {:>7.2} MB | binary {:>7.2} MB ({:.2}x smaller)",
            json.len() as f64 / 1e6,
            bin.len() as f64 / 1e6,
            json.len() as f64 / bin.len() as f64,
        );
        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(BenchmarkId::new("json_decode", n), &json, |b, j| {
            b.iter(|| {
                let s: VectorStore = serde_json::from_slice(black_box(j)).unwrap();
                black_box(s.records.len())
            })
        });
        group.bench_with_input(BenchmarkId::new("binary_decode", n), &bin, |b, j| {
            b.iter(|| black_box(VectorStore::decode(black_box(j)).unwrap().records.len()))
        });
    }
    group.finish();
}

/// Write-side cost: reindex saves the whole store, so encode time is user-visible.
fn bench_serialize(c: &mut Criterion) {
    let mut group = c.benchmark_group("serialize");
    group.sample_size(20);
    for &n in &[1_000usize, 10_000] {
        let store = synth_store(n);
        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(BenchmarkId::new("json_encode", n), &store, |b, s| {
            b.iter(|| black_box(serde_json::to_vec(black_box(s)).unwrap().len()))
        });
        group.bench_with_input(BenchmarkId::new("binary_encode", n), &store, |b, s| {
            b.iter(|| black_box(black_box(s).encode().len()))
        });
    }
    group.finish();
}

/// The inner loop of every search. `cosine` recomputes both norms per call even
/// though the store's vectors are already normalized; `dot` skips that.
fn bench_similarity(c: &mut Criterion) {
    let mut rng = Xorshift(0xDEADBEEF);
    let a = synth_vector(&mut rng);
    let b_vec = synth_vector(&mut rng);
    let mut group = c.benchmark_group("similarity");
    group.throughput(Throughput::Elements(DIM as u64));
    group.bench_function("cosine", |bch| {
        bch.iter(|| black_box(cosine(black_box(&a), black_box(&b_vec))))
    });
    group.bench_function("dot", |bch| {
        bch.iter(|| black_box(dot(black_box(&a), black_box(&b_vec))))
    });
    group.finish();
}

/// A full top-k scan over the whole index — the hot path of `semantic_search`.
fn bench_search(c: &mut Criterion) {
    let mut group = c.benchmark_group("search");
    group.sample_size(20);
    for &n in &[1_000usize, 10_000] {
        let store = synth_store(n);
        let mut rng = Xorshift(0xC0FFEE);
        let q = synth_vector(&mut rng);
        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(BenchmarkId::new("scan_top10", n), &store, |b, s| {
            b.iter(|| black_box(s.search(black_box(&q), 10).len()))
        });
    }
    group.finish();
}

/// Whole-vault edge build. Both shapes are quadratic in pages; the baseline is
/// additionally quadratic in chunks per page, which is the factor the centroid
/// formulation removes. Benched at realistic page counts rather than the
/// 10k-record sizes above — the baseline at 10k records is minutes, not ms.
fn bench_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("edges");
    group.sample_size(10);
    for &pages in &[100usize, 300] {
        let store = synth_store(pages * CHUNKS_PER_PAGE);
        group.throughput(Throughput::Elements(pages as u64));
        group.bench_with_input(BenchmarkId::new("best_chunk_baseline", pages), &store, |b, s| {
            b.iter(|| black_box(edges_best_chunk(black_box(s), 5)))
        });
        group.bench_with_input(BenchmarkId::new("centroid", pages), &store, |b, s| {
            b.iter(|| black_box(black_box(s).centroid_edges(5).len()))
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_store_load,
    bench_serialize,
    bench_similarity,
    bench_search,
    bench_edges
);
criterion_main!(benches);
