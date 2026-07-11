# Graph Overhaul + Built-in Model Swap — Design

Date: 2026-07-12
Status: approved (user), implementing in increments on `main`

## Scope (user request)

1. Replace the built-in opt-in model (HyperCLOVA X SEED 0.5B) with **Gemma 3 1B**.
2. Graph-only color mode, independent of the app theme: **auto / black / white / galaxy**.
3. More interactive motion graphics so the graph reads as a galaxy / neural network:
   neural activation wave, supernova on select, ambient meteors, idle synapse firing.
4. Spaceship mode: replace the arrow-like procedural ship with a **real ship model
   (free CC0 asset)** and an **inertia flight model** (accel/drag/banking/thruster trail).

## 1. Built-in model → Gemma 3 1B

- Asset: `ggml-org/gemma-3-1b-it-GGUF` → `gemma-3-1b-it-Q4_K_M.gguf` (768.7 MB,
  sha256 `8ccc5cd1…b75a135`), stored as
  `app/src-tauri/models/gemma-3-1b-it-q4_k_m.gguf` (git LFS, replaces SEED gguf).
- License: remove `LICENSE-hyperclovax-seed.txt`, add Gemma Terms of Use text.
- Code: `local_llm.rs` (docs + ignored test path), `commands.rs` (model path
  constant), `tauri.conf.json` (bundle resource), `providers.ts` (catalog name
  `gemma-3-1b`), i18n `q_builtin_note` en/ko/ja (built-in *is* Gemma now; nudge
  points at larger Ollama models / Claude).
- Embeddings reuse the same weights; the vector store is keyed by model id, so a
  model switch invalidates the index → verify `ensure_model` wipe + reindex path.
- Docs: `README.md`, `README-ko.md`, `app/README.md` SEED mentions.
- Risk: GitHub LFS free quota (existing 412 MB + new 769 MB); report if push fails.

## 2. Graph skin (independent of app theme)

- `graphSettings.skin: 'auto' | 'black' | 'white' | 'galaxy'`, default `auto`
  (follows app theme = current behavior, no breaking change).
- `graphTheme.ts`: `makeTheme(skin)` — `auto` = `readTheme()`; `black` = pure-black
  fixed palette, starfield/nebula off; `white` = fixed light palette; `galaxy` =
  deep-space background, 3 starfield shells, nebula boosted.
- `GraphScene.setSkin()` reuses the existing `applyTheme` path (no rebuild).
- Segmented control in `GraphControls`, i18n en/ko/ja.

## 3. Motion graphics

All plug into the existing rAF loop and respect interaction LOD / perf mode
(≥5k nodes) / `ambientMotion`:

- **ActivationWave** — on node select, BFS (depth ≤ 3, capped) fires edges in
  depth-staged sequence with node flashes; scheduling logic in a pure module.
- **SupernovaFX** — select flash + expanding ring sprite (~0.6 s).
- **MeteorLayer** — galaxy skin only; a streak crosses the background every
  8–20 s (deterministic RNG).
- **SynapseFire** — idle: random node micro-fires and propagates 1–2 hops at low
  intensity; suppressed while interacting.

## 4. Spaceship

- Ship: free CC0 GLB (Kenney Space Kit / Quaternius Ultimate Space Kit), bundled;
  `GLTFLoader`; current procedural ship kept as load-failure fallback.
- Flight model in `shipPhysics.ts` (pure, unit-tested): thrust acceleration,
  exponential drag, max speed, Shift boost, banking roll proportional to yaw
  rate, smoothed mouse steering.
- Engine particle trail scaled by throttle; speed readout in `ShipHud`.

## Verification per increment

`npm run test` (vitest) + `cargo test` + `npm run build` + `node scripts/route-smoke.mjs`;
one commit per increment on `main` (established repo workflow).
