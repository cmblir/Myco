# Embedded Local Model — Design Spec

- **Date:** 2026-07-01
- **Status:** Phase 0 validated (GO); Phase 1 integration pending (model-bundling decision)
- **Scope:** Ship a small generative model **inside the app** so Memex works
  offline with zero setup — no Ollama install, no API key. The bundled model
  handles light tasks (classify / query / tag / rough draft). High-quality
  ingest stays on the paid tier.

## Decisions (locked)

1. **Model:** **HyperCLOVAX-SEED-Text-Instruct-0.5B** (NAVER, Korean-native).
   Q4_K_M GGUF **~412 MB**. Chosen over Qwen2.5-0.5B after a spike: Qwen leaked a
   Chinese character (集) into Korean output and its Korean was weak; SEED is
   Korean-first — clean, fluent Korean, **no Chinese leakage**, and higher Korean
   benchmarks (KMMLU/HAE-RAE/KoBEST) at the same size. Rejected: Qwen (Chinese
   contamination), EXAONE-2.4B (NC license). NOTE: verify the `hyperclovax-seed`
   license permits bundling/redistribution before shipping. llama.cpp-compatible
   (community GGUFs exist), so GBNF grammar + Metal are available.

   **Spike findings (Ollama, SEED 0.5B Q4):** classification with an enum
   harness → clean valid labels (KO + EN notes). Language-matched query → fluent
   KO for KO, EN for EN, no Chinese. BUT factual accuracy is unreliable at 0.5B
   (asked RLHF's meaning → hallucinated "Relational Learning…"). So: classify +
   light/stylistic query = embedded; factual/high-quality ingest = paid tier.
2. **Delivery: BUNDLED**, not download-on-first-run. The app must be
   self-contained from install. The model file ships as a Tauri resource. Accept
   the installer growing from ~3.6 MB to roughly the model size.
3. **Runtime:** **llama-cpp-2** (llama-cpp-rs bindings) — GGUF, Metal on arm64,
   and crucially **GBNF grammar** so classification output is *forced* into the
   `concept|entity|technique|source-summary|analysis` enum (and non-Hangul/CJK
   can be grammar-excluded) — no runaway loops, no Chinese leak, 100% valid
   labels. Cost: it vendors + compiles llama.cpp (C++ toolchain, slower build) —
   validated in Phase 0. Fallback: pure-Rust **candle** with a custom
   constrained sampler if the C++ build proves troublesome (no GBNF, more manual).
4. **Capability split (product):** the embedded 0.5B model is the free, offline
   **default** for light tasks. **High-quality ingest** (structured citations,
   contradiction detection, Korean nuance) is a **paid tier** routed to
   Claude / HTTP APIs / memex-pro — the embedded model is honestly not good
   enough for it and must not pretend to be.
5. **Embeddings** (semantic search / suggested links) remain a **separate,
   optional** later feature (see [[2026-06-27-cosmic-web-graph]] Phase 4 tie-in).

## Architecture

Slots into the existing provider abstraction — the embedded model is just a new
provider, so routing/UI changes are minimal.

```
src-tauri/src/local_llm.rs   NEW. Load the bundled GGUF (candle), generate().
                             Exposes a chat_complete-shaped call.
providers.rs                 Register a `builtin` provider id alongside
                             anthropic/ollama/openai/…; it has NO filesystem
                             tools, so it runs like the HTTP providers: inline
                             vault context via read_vault_context.
tauri.conf.json              Bundle the .gguf as a resource; resolve its path
                             at runtime.
settings.rs / PageSettings   `builtin` is always "connected" (no key/install);
                             a Metal/threads toggle; the paid tiers stay as-is.
chat.ts                      `builtin` in the non-tool provider path (query /
                             classify / lint), never the tool-ingest path.
```

## Task routing

| Task | Provider |
|------|----------|
| classify / tag / quick query / rough draft | **builtin (bundled 0.5B)** — free, offline |
| high-quality ingest (cited wiki authoring, contradiction detection) | **paid tier** — Claude CLI / HTTP API / memex-pro |
| semantic search / suggested links (optional) | separate embed layer (later) |

## Phased plan

0. **Spike — DONE (validated in an isolated cargo project):**
   - `llama-cpp-2` v0.1.150 builds under the app's release profile
     (`lto=true`, `panic="abort"`, `opt-level="s"`) in ~5 min (first build only).
   - Loads the SEED 0.5B Q4 GGUF, **Metal acceleration active** on arm64,
     in-process (no daemon).
   - Classification: **greedy + short cap + enum post-validation** yields a valid
     label. GBNF grammar CRASHES in this vendored llama.cpp
     (`GGML_ASSERT(!stacks.empty())`, PR #17869) — so the harness is
     post-validation (match output against the 5 labels), NOT GBNF, until a fixed
     llama.cpp ships. Robust because SEED emits clean labels.
   - Free-form query runs but is context-dependent (asked "what is a transformer"
     with no context → answered the *electrical* transformer). In-app query MUST
     inline `read_vault_context` for grounding; hard/factual → paid tier.
1. `local_llm.rs` + bundle the resource + `builtin` provider registration.
2. Route query / classify / lint to `builtin` (inline context).
3. Paid-tier gating for high-quality ingest (memex-pro / API / Claude).

## Success criteria

- Fresh install → the graph, editor, and a working local query/classify with
  **no Ollama, no API key, no network**.
- `tsc -b && vite build` + `cargo build --release` pass; the .dmg bundles the
  model; the release profile still builds with the new dep.
- Korean + English light tasks produce usable output from the bundled 0.5B.
- Heavy ingest clearly routes to (and requires) the paid tier.

## Risks

- **0.5B Korean/quality** — the biggest unknown; Phase 0 must benchmark on real
  KO+EN notes before committing. 0.5B is small; output may be rough.
- **Installer size** — ~3.6 MB → ~400 MB. Makes macOS **notarization** (not just
  ad-hoc unsigned) materially more important for distribution.
- **candle Qwen wiring** — quantized Qwen2 load + tokenizer + sampling is manual;
  if it fights us, fall back to llama-cpp-rs (accepts a C++ build).
- **Release build cost** — a transformer/inference crate + `lto` may slow builds
  and interact with `panic="abort"`; validate in Phase 0.
- **License hygiene** — ship only Apache/permissive weights; EXAONE (NC) and
  jina-v3 (CC-BY-NC) must never enter a shipped build.
