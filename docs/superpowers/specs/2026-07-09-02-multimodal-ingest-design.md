# Feature 2 — Multi-modal Source Ingestion — Design

Date: 2026-07-09
Priority: 2. Depends on: none (independent of #1). Composes with the existing
ingest pipeline.
Scope: `app/src-tauri` (Rust: `extract.rs`, new `transcribe.rs`, `commands.rs`,
`extract` worker in `main.rs`), `app/src/pages/PageIngest.tsx`,
`app/src/lib/{ipc,chat,providers}.ts`, `automation/autoingest.py`,
`app/src/lib/i18n.ts`.

## Problem / opportunity

Ingest today accepts text / markdown (plus PDF & XLSX text via the isolated
`memex --extract-text` worker). Most real sources are richer: PDFs that are scanned
images, YouTube talks, meeting/voice recordings, screenshots/diagrams, and Office
docs. Users must transcribe/convert by hand before Memex can turn them into a cited
wiki page. Extending the *front* of the pipeline — everything after extraction
already works (raw → LLM ingest → `wiki/source-*.md` with `[^src-*]` citations).

## Decisions (settled)

- **Reuse the existing pipeline.** Every new source type is normalized to text and
  written as a NEW `raw/<slug>.md` (originals never mutated); the current
  ingest→wiki flow is unchanged downstream.
- **Three extraction tiers by locality:**
  1. *Isolated worker* (`extract.rs`, no model): PDF text, docx/pptx, images→OCR.
  2. *Local model*: audio/video → Whisper transcription (offline).
  3. *LLM call*: image → vision description (reuse `providers.rs`, opt-in cloud).
- **Offline-first:** text extraction, OCR, and Whisper run locally with no key;
  cloud vision/transcription is opt-in with keychain keys.

### Open sub-decisions (finalize at implementation)
- **Bundle Whisper?** whisper.cpp via `whisper-rs` (new Rust dep) + a bundled GGUF.
  Size tradeoff: `ggml-base` (~140 MB, decent) vs `ggml-small` (~460 MB, better,
  multilingual for ko/ja). Recommendation: bundle `base`, offer `small` as an
  optional download. Alternative: no bundle, transcription via provider only.
- **OCR engine:** bundle Tesseract (heavy, native) vs a small ONNX OCR vs
  vision-LLM OCR. Recommendation: vision-LLM OCR for scanned PDFs/images when a
  provider is connected; a lightweight local OCR only if a good offline option fits
  the bundle budget — otherwise mark scanned-PDF OCR "needs a vision provider".
- **YouTube transcripts:** method + legality. Prefer the video's own caption track
  (yt-dlp-style subtitle fetch) over scraping; document that only user-authorized
  fetching is supported. Decide whether this ships in-app (Rust HTTP) or via the
  Python `automation/` side (already network-capable).
- **Video:** extract audio track (ffmpeg) then Whisper, or require pre-extracted
  audio. ffmpeg is a heavy/native dep — likely defer video, ship audio-only first.

## Architecture

### A. Extraction worker (`extract.rs` + `main.rs --extract-text`)
- Extend the isolated worker (already sandboxes hostile parsers in a child process)
  with docx/pptx (zip+XML text) and image→OCR. Keeps parser crashes/OOM contained.
- `extract_text(path)` dispatches by extension; returns plain text + minimal
  metadata (title, page/section markers) for citation anchoring.

### B. Transcription (`transcribe.rs` — new, local)
- `EmbedState`-style lazy `WhisperState` holding a bundled Whisper GGUF via
  `whisper-rs`; `transcribe(path) -> String` on `spawn_blocking`, emits progress
  events. Audio only in v1 (`.mp3/.m4a/.wav`); video deferred (see open decisions).
- Model path resolved like the SEED model (`<resource_dir>/models/whisper-*.bin`).

### C. Vision + provider transcription (`providers.rs`, `chat.ts`)
- `describe_image(path, provider)` — send image to a vision-capable provider
  (Anthropic/OpenAI/Google) for a structured description + any legible text (OCR).
- Cloud transcription fallback (e.g. OpenAI Whisper API) when no local Whisper.

### D. Ingest surface (`PageIngest.tsx`, `ipc.ts`)
- Drop zone accepts the new types; a source-type badge + per-type progress
  (extract / transcribe / vision) reuses the existing 6-stage stepper.
- New IPC: `extract_source(path)` (routes to worker/whisper/vision by type) → writes
  `raw/<slug>.md` with a provenance header (original filename, sha, extractor used,
  timestamp) → then the normal `ingest` runs.
- `automation/autoingest.py` `_inbox/` watcher gains the same type routing so
  dropping a PDF/audio/image into `_inbox/` auto-ingests unattended.

## Constraints fit
- `raw/` immutability preserved: extracted text/transcripts are NEW raw entries;
  the original binary is copied (not moved/edited) into an assets area or referenced
  by path, never modified. Offline default (worker + Whisper + local OCR); cloud
  vision/transcription opt-in, keychain keys, no telemetry. Plain markdown out.

## Error handling
- Parser/transcription failure is contained (isolated worker already; Whisper errors
  return a message) → surfaces in the ingest stepper as a failed stage with the raw
  file left for manual retry; no rollback of prior raw entries.
- Unsupported/oversized files rejected with a clear message (reuse the >2 MB / type
  guards). Missing local model → fall back to provider or a "needs a provider" hint.

## Testing / verification
- Rust unit: docx/pptx text extraction on fixtures; extension routing; provenance
  header format. Whisper transcription smoke on a short bundled wav (skip if model
  absent). Vision path mocked (no network in tests).
- End-to-end (Playwright + mock): drop a PDF/image → a `raw/*.md` appears → ingest
  stepper completes → a `wiki/source-*.md` with `[^src-*]` citations exists.
- `automation/autoingest.py` test: a PDF in `_inbox/` archives on success.
- `tsc -b`, `eslint`, `vitest run`, `cargo test` clean.

## Rollout
Ship text/docx/pptx + image-vision first (no new heavy bundle). Whisper audio behind
a bundle-size flag / optional model download. Video + local OCR deferred. Call out
any bundled model size in release notes.
