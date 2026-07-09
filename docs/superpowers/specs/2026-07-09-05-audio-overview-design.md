# Feature 5 — Audio Overview (Spoken Deep-Dive) — Design

Date: 2026-07-09
Priority: 5. Depends on: none (stronger with #1 for page selection, but independent).
Scope: `app/src-tauri` (Rust: TTS engine + job runner), `app/src/lib`
(script-gen prompt, job store), `app/src/pages` (PageQuery / PageReader entry +
a player), `app/src/components` (AudioOverviewPanel, mini player),
`app/src/lib/i18n.ts`.

## Problem / opportunity

Memex pages are dense, cited markdown. Reviewing a cluster of related notes means
reading. NotebookLM's Audio Overview proved a high-value alternative: one click
turns a set of sources into a lively, two-host spoken "deep dive" that summarizes
and connects them, generated in the background while you keep working. It is
"an objective reflection of your source content" — the same source-grounding
Memex already enforces via citations, so every spoken claim traces to a page.

Memex has the LLM plumbing and cited pages; it lacks (a) a script generator and
(b) any text-to-speech. The whole feature hinges on keeping TTS offline to honor
the local-first/no-telemetry ethos.

## Decisions (settled)

- **Grounding:** the dialogue is generated only from selected wiki pages (their
  markdown + `[^src-*]`/`[[wikilink]]` context), never free invention — mirrors the
  citation contract. The transcript keeps page references inline.
- **Inputs:** a user-chosen set of pages — from a Query answer's cited "galaxy", a
  graph community, a folder, or the current Reader page + its neighbours.
- **Output persists in the vault** as plain files (no lock-in): audio under
  `audio/<slug>-<date>.<ext>` and a `audio/<slug>-<date>.md` transcript (speaker-
  tagged, with the source page list), so it is portable and Obsidian-visible.
- **Background job**, reusing the ingest 6-stage stepper pattern (script → synth →
  encode → done) with live status + cancellation.
- **Offline default:** ship a bundled local TTS engine; a cloud TTS provider is
  opt-in with keys in the OS keychain. No audio or text leaves the machine by
  default; no telemetry.

## Architecture

### A. Script generation (`app/src/lib/audioOverview.ts` — new)
- Assemble the selected pages (bounded by a token budget; if #1 shipped, rank/trim
  with semantic top-K, else concat like `read_vault_context`).
- One LLM call (existing multi-provider stack, bundled SEED as offline default) with
  a prompt producing a **structured two-host dialogue**: JSON array of
  `{ speaker: "A"|"B", text, cites: string[] }` turns, hosts named (e.g. Host/Guest),
  ~5–12 min target, instructed to stay grounded and cite pages. Validate/repair JSON.
- Persist the transcript markdown immediately (before synth) so a synth failure
  still leaves a usable artifact.

### B. Text-to-speech (Rust, `app/src-tauri/src/tts.rs` — new)
- `synthesize(turns, voices) -> audio_path`: per-turn synth with a distinct voice
  per speaker, concatenated with short gaps into one file.
- **Bundled local engine** resolved like the SEED model
  (`<resource_dir>/tts/...`); runs on `spawn_blocking`, streams progress events.
- **Cloud provider path** (`tts_via_provider`) reusing keychain + HTTP adapters,
  opt-in only.
- IPC: `generate_audio_overview(pages, opts)`, `audio_overview_status(job)`,
  `cancel_audio_overview(job)`.

### C. UI
- Entry buttons: "Audio overview" on PageQuery (over the cited pages) and PageReader
  (this page + neighbours). Opens `AudioOverviewPanel` (pick voices/length, start).
- Background job → global mini player (persistent bar, like the ingest chip) with
  play/pause/scrub; clicking a transcript turn seeks; a completed overview is listed
  in `audio/` and re-openable from Reader.

### D. Settings
- TTS engine select (bundled default vs provider), voice pickers, target length,
  audio format. Reuse the Settings Model/Connections patterns.

## Open decisions (finalize at implementation)
- **TTS engine + bundle size (the crux):** local **Piper** (small ONNX voices,
  ~20–60 MB/voice, many languages incl. ko/ja, permissive) vs **Kokoro** (higher
  quality, larger) vs cloud-only default (no bundle bloat but breaks offline). Lean
  Piper for the offline default; confirm engine + which/how-many bundled voices and
  the added installer size.
- **Voices:** two bundled voices (multi-host) vs single-narrator v1 (simpler). Lean
  two.
- **Audio format/codec:** WAV (simple, large) vs MP3/Opus (needs an encoder dep).
  Lean Opus/MP3 for size; confirm encoder.
- **Multilingual:** match the host voices to the vault language (ko/ja/en) — depends
  on bundled voice set.

## Constraints fit
- Offline by default (bundled TTS + bundled SEED for the script); artifacts are plain
  files in the vault → portable, no lock-in; `raw/` untouched. Cloud TTS strictly
  opt-in with keychain keys; no telemetry.

## Error handling
- Script JSON invalid after repair → fall back to a single-narrator summary.
- TTS engine missing/failed → keep the transcript, surface the error, offer the
  cloud path; never crash the app.
- Cancellation mid-synth cleans partial audio; transcript is retained.

## Testing / verification
- Rust unit: turn→audio concat length, voice mapping, cancellation cleanup, provider
  fallback.
- JS unit: dialogue-JSON parse/repair, page-budget assembly, transcript formatting.
- Playwright: trigger from Query → job progresses → player appears → transcript turns
  render with page cites; Settings voice/engine select.
- `tsc -b`, `eslint`, `vitest run` clean.

## Rollout
Behind an "Audio overview" capability flag; disabled until a TTS engine is present.
Bundling voices adds to installer size — call out in release notes. Ships after the
higher-priority features; benefits from #1 (better page selection) but does not
require it.
