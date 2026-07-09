# Feature 1 — Local Embeddings + Vector Layer — Design

Date: 2026-07-09
Priority: 1 (highest ROI). Depends on: none. Enables graph/search/Q&A upgrades.
Scope: `app/src-tauri` (Rust: embedding model + LanceDB), `app/src/lib`
(chat/search/graph), `app/src/components` (Reader panel, GraphControls),
`app/src/pages` (Settings), `app/src/lib/i18n.ts`.

## Problem / opportunity

Memex links pages only via LLM-authored `[[wikilinks]]`, keyword substring search,
and graph traversal. It has no *semantic* similarity. Two concrete weaknesses:
- Q&A inlines the **whole vault** up to a byte budget (`vault::read_vault_context`,
  no ranking) — poor and expensive on large vaults; sections that don't fit are
  silently dropped.
- Keyword search (`vault::search_vault`) misses semantically-related notes when the
  exact words differ.

A local, on-device embedding index closes both and feeds three more surfaces.

## Decisions (settled)

- **Embedding source: bundled model (default) + optional provider.** Bundled runs
  offline via the existing llama.cpp stack (llama-cpp-2 exposes
  `LlamaContextParams::with_embeddings(true)` + `with_pooling_type(Mean)` +
  `LlamaContext::embeddings_seq_ith`). Providers (OpenAI `text-embedding-3-small`,
  Google, Ollama `nomic-embed-text`) selectable in Settings; keys in keychain.
- **Vector store: LanceDB** (embedded Rust `lancedb` crate). New dependency.
- **Scope (all four surfaces):** Q&A top-K retrieval, semantic ⌘K search, Reader
  related-notes panel, graph similarity edges.

### Open sub-decision (finalize at implementation)
Bundled model size vs multilingual quality: default **multilingual-e5-small**
(~400 MB q8, 384-dim, handles the vault's ko/ja) vs **bge-small-en** (~130 MB,
English-only, multilingual via provider). Recommendation: multilingual-e5-small
so the offline default works on ko/ja content; confirm before bundling.

## Architecture

### A. Embedding backend (Rust, `src-tauri/src/embeddings.rs` — new)
- `EmbedModel` holds a second `LlamaModel` loaded with an embeddings context
  (`with_embeddings(true)`, pooling Mean), parallel to `local_llm.rs`. Bundled GGUF
  resolved like the SEED model (`<resource_dir>/models/<embed>.gguf`, dev fallback).
- `embed(texts: &[String]) -> Vec<Vec<f32>>` — batch, L2-normalize.
- Provider path: `embed_via_provider(provider, model, texts)` reusing the keychain +
  HTTP adapters in `providers.rs`; Ollama via its `/api/embeddings`.
- Held in Tauri state (`EmbedState`, lazy-loaded like `LocalLlmState`), run on
  `spawn_blocking`.

### B. Vector store (Rust, `src-tauri/src/vector_index.rs` — new)
- LanceDB table under `settings_dir()/embeddings/<vault-hash>/` (vault path hashed;
  keeps vaults isolated). Row: `{ id: "path#section", page: relpath, stem, section:
  int, content_hash, mtime, vector: fixed-size-list<f32> }`.
- **Chunking:** split each `wiki/**/*.md` page into ~512-token sections on heading /
  blank-line boundaries; embed each section (better top-K than whole-page).
- **Lifecycle:**
  - `reindex_embeddings(force?)` — backfill all pages; skip unchanged (content_hash);
    delete rows for removed pages. Emits progress events for a Settings progress bar.
  - Incremental: called after ingest (`PageIngest`) and after Reader autosave for
    the touched page(s) only.
- **Query:** `semantic_search(query, k, filter?) -> Vec<Hit{page, section, score,
  snippet}>` — embed query, LanceDB ANN top-K; `related_pages(page, k)` — nearest
  neighbours of a page's mean vector, excluding itself.
- IPC commands: `reindex_embeddings`, `semantic_search`, `related_pages`,
  `embeddings_status` (indexed count / dirty count / model).

### C. Integrations
1. **Q&A top-K** (`app/src/lib/chat.ts`): when the index is ready and the provider
   uses inlined context (HTTP/local, not tool-capable Claude CLI), replace the
   whole-vault dump with `semantic_search(question, k)` → assemble only the top
   sections into the system context, each tagged with its `[[stem]]` for citation.
   Fallback to `read_vault_context` when the index is empty. (Claude-CLI tool path
   unchanged; a later phase can pass top-K page hints.)
2. **Semantic ⌘K** (`app/src/components/CommandBar.tsx`): run `semantic_search` in
   parallel with `searchVault`; merge, de-dupe by page, label semantic hits.
3. **Reader related-notes** (`app/src/components/BacklinksPanel.tsx` sibling or a new
   `RelatedPanel.tsx`): `related_pages(currentPage, 8)` → clickable list with score.
4. **Graph similarity edges** (`app/src/lib/graphData.ts` `buildGraph`, ~line 401):
   after the wikilink-edge loop, inject top-N `related_pages` edges with
   `GraphEdgeAttrs.kind: "semantic"` (extend the attr type). Distinct dashed/dim
   style in `graphScene.ts`; a "Semantic links" toggle in `GraphControls.tsx`
   (off by default; edges keyed separately so they don't collide with the
   `!hasEdge` guard on already-wikilinked pairs).

### D. Settings (`PageSettings.tsx` Model tab or a new "Search" area)
- Embedding provider/model picker (reuse `ModelSelect`), bundled default.
- "Semantic features" master toggle; "Reindex now" button + progress/status.

## Constraints fit
- Offline by default (bundled model); vectors live outside the vault in app-data →
  pages stay plain markdown, no lock-in, index is rebuildable. No telemetry;
  provider embeddings are opt-in with keychain keys. `raw/` never embedded-then-
  mutated (read-only). Large-vault safe: ANN + incremental indexing.

## Error handling
- Missing/failed embed model → semantic features disabled gracefully, keyword +
  whole-vault fallback; surfaced in `embeddings_status`.
- LanceDB open failure → disable + log; never block the app.
- Dimension mismatch on model change → wipe + reindex (guard by stored model id).

## Testing / verification
- Rust unit: cosine/normalize, chunker boundaries, content-hash dirty detection,
  LanceDB round-trip (insert → query → expected neighbour), dimension-mismatch wipe.
- Retrieval accuracy on a synthetic vault (planted near-duplicates rank top-1).
- Playwright: ⌘K shows a semantic hit for a paraphrased query; Reader shows related
  notes; graph "Semantic links" toggle adds dashed edges; Settings reindex progresses.
- `tsc -b`, `eslint`, `vitest run` clean; existing tests pass.

## Rollout
Ship behind the "Semantic features" toggle (default on once a backfill completes;
off until first index). Bundling the embed model adds ~400 MB to the installer —
call out in release notes.
