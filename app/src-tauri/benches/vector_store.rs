//! Baseline benchmarks for the semantic layer's vector store.
//!
//! Pure CPU — no GGUF, no Metal, no model load — so these numbers are stable and
//! reproducible on any machine. They exist to justify (or kill) four proposed
//! optimizations before any of them ship:
//!
//!   1. `store_load`   — how much per-call JSON reparse actually costs (motivates
//!                       an in-memory cache).
//!   2. `serialize`    — JSON vs a raw-f32 binary format, encode and decode.
//!   3. `similarity`   — full `cosine` vs a dot-product fast path for vectors that
//!                       are already L2-normalized at write time.
//!   4. `edges`        — today's best-chunk-vs-best-chunk `semantic_edges` against
//!                       a page-centroid formulation.
//!
//! Candidate implementations live here, next to the real ones, so a proposal is
//! measured before it is shipped. Once a winner lands in `vector_index.rs`, its
//! candidate here should be deleted and the bench re-pointed at the real code.
//!
//! Run: `cargo bench --bench vector_store`

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use memex_lib::embeddings::{cosine, normalize};
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

// ---------------------------------------------------------------------------
// Candidate: raw-f32 binary codec (proposal B3).
//
// Layout: [b"MXV1"][dim u32][n u32] then per record a length-prefixed id/page/
// stem, section u32, hash u64, and `dim` little-endian f32s written as one bulk
// slice. Deliberately hand-rolled rather than pulling in a serialization crate:
// the vectors are ~99% of the bytes, so the format is trivial and stays ours.
// ---------------------------------------------------------------------------

fn encode_binary(store: &VectorStore) -> Vec<u8> {
    let mut out = Vec::with_capacity(store.records.len() * (store.dim * 4 + 64));
    out.extend_from_slice(b"MXV1");
    out.extend_from_slice(&(store.dim as u32).to_le_bytes());
    out.extend_from_slice(&(store.records.len() as u32).to_le_bytes());
    let put_str = |out: &mut Vec<u8>, s: &str| {
        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    };
    for r in &store.records {
        put_str(&mut out, &r.id);
        put_str(&mut out, &r.page);
        put_str(&mut out, &r.stem);
        out.extend_from_slice(&(r.section as u32).to_le_bytes());
        out.extend_from_slice(&r.hash.to_le_bytes());
        for x in &r.vector {
            out.extend_from_slice(&x.to_le_bytes());
        }
    }
    out
}

fn decode_binary(bytes: &[u8]) -> VectorStore {
    let mut p = 4usize; // skip magic
    let take_u32 = |b: &[u8], p: &mut usize| -> u32 {
        let v = u32::from_le_bytes(b[*p..*p + 4].try_into().unwrap());
        *p += 4;
        v
    };
    let dim = take_u32(bytes, &mut p) as usize;
    let n = take_u32(bytes, &mut p) as usize;
    let mut records = Vec::with_capacity(n);
    for _ in 0..n {
        let take_str = |b: &[u8], p: &mut usize| -> String {
            let len = take_u32(b, p) as usize;
            let s = String::from_utf8_lossy(&b[*p..*p + len]).into_owned();
            *p += len;
            s
        };
        let id = take_str(bytes, &mut p);
        let page = take_str(bytes, &mut p);
        let stem = take_str(bytes, &mut p);
        let section = take_u32(bytes, &mut p) as usize;
        let hash = u64::from_le_bytes(bytes[p..p + 8].try_into().unwrap());
        p += 8;
        let mut vector = Vec::with_capacity(dim);
        for _ in 0..dim {
            vector.push(f32::from_le_bytes(bytes[p..p + 4].try_into().unwrap()));
            p += 4;
        }
        records.push(Record { id, page, stem, section, hash, vector });
    }
    VectorStore { model: "builtin-local:".into(), dim, records }
}

// ---------------------------------------------------------------------------
// Candidate: dot product (proposal B4b). Valid only because the store holds
// L2-normalized vectors; keeps `cosine`'s length guard so a dimension mismatch
// scores 0 rather than panicking or reading a truncated vector.
// ---------------------------------------------------------------------------

fn dot(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut acc = 0.0f32;
    for i in 0..a.len() {
        acc += a[i] * b[i];
    }
    acc
}

// ---------------------------------------------------------------------------
// Candidate: centroid-based semantic_edges (proposal B4a). One vector per page
// instead of every chunk against every chunk.
// ---------------------------------------------------------------------------

fn page_centroids(store: &VectorStore) -> Vec<(String, Vec<f32>)> {
    use std::collections::HashMap;
    let mut acc: HashMap<&str, (Vec<f32>, usize)> = HashMap::new();
    for r in &store.records {
        let e = acc.entry(r.page.as_str()).or_insert_with(|| (vec![0.0; store.dim], 0));
        for (i, x) in r.vector.iter().enumerate() {
            e.0[i] += x;
        }
        e.1 += 1;
    }
    acc.into_iter()
        .map(|(page, (mut v, n))| {
            for x in v.iter_mut() {
                *x /= n as f32;
            }
            normalize(&mut v);
            (page.to_string(), v)
        })
        .collect()
}

/// Today's shape: every page against every other page, best chunk vs best chunk.
fn edges_current(store: &VectorStore, k: usize) -> usize {
    let pages: std::collections::HashSet<&str> =
        store.records.iter().map(|r| r.page.as_str()).collect();
    let mut count = 0;
    for page in &pages {
        count += store.related(page, k).len();
    }
    count
}

/// Proposed shape: one centroid per page, so the inner chunk loops collapse.
fn edges_centroid(store: &VectorStore, k: usize) -> usize {
    let cents = page_centroids(store);
    let mut count = 0;
    for (i, (_, a)) in cents.iter().enumerate() {
        let mut hits: Vec<f32> = cents
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != i)
            .map(|(_, (_, b))| dot(a, b))
            .collect();
        hits.sort_by(|x, y| y.partial_cmp(x).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(k);
        count += hits.len();
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
        let bin = encode_binary(&store);
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
            b.iter(|| black_box(decode_binary(black_box(j)).records.len()))
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
            b.iter(|| black_box(encode_binary(black_box(s)).len()))
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

/// Whole-vault edge build. Quadratic in pages *and* quadratic in chunks per page
/// today, so it is benched at realistic page counts rather than the 10k-record
/// sizes above — at 10k records the current implementation is minutes, not ms.
fn bench_edges(c: &mut Criterion) {
    let mut group = c.benchmark_group("edges");
    group.sample_size(10);
    for &pages in &[100usize, 300] {
        let store = synth_store(pages * CHUNKS_PER_PAGE);
        group.throughput(Throughput::Elements(pages as u64));
        group.bench_with_input(BenchmarkId::new("current_best_chunk", pages), &store, |b, s| {
            b.iter(|| black_box(edges_current(black_box(s), 5)))
        });
        group.bench_with_input(BenchmarkId::new("centroid", pages), &store, |b, s| {
            b.iter(|| black_box(edges_centroid(black_box(s), 5)))
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
