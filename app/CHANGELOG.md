# Changelog

All notable changes to Memex are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The graph now shows where your attention is.** Notes edited in the last two
  weeks burn hotter and warmer; untouched ones cool off — the vault reads as a
  live map of what you're working on. Toggle under Graph settings ("Recency
  glow").

- **Typing in the graph's find box lights up every match.** All matching notes
  pulse together while the rest recede, so the matched set pops out before you
  even press Enter to fly to the best one.

- **Notes of the same kind now share a star shape.** Sources are piercing spiked
  beacons, entities big warm giants, techniques dense small cores — a consistent,
  colour-blind-safe glyph channel instead of a random population (untyped notes
  keep the varied sky).

- **Overlapping stars keep their edges.** A subtle separation ring between a
  star's core and halo stops dense clusters from fusing into one blob — nearer
  stars get the stronger ring, the far field stays a soft continuum.

- **Every vault gets its own sky.** Deep-space skins now bake a faint seeded
  nebula backdrop from the vault's identity — the same vault always opens under
  the same sky, and no two vaults share one. Baked once off the critical path,
  zero per-frame cost, and deliberately a whisper so the graph keeps the stage.

- **Stars no longer shimmer at a distance.** Node edges are now pixel-exact at
  every sprite size (screen-space-aware profiles): large stars keep their
  designed look, tiny distant ones melt into clean round points instead of
  crawling as the camera drifts.

- **Truer colours under glow.** Tone mapping moved from ACES to AgX: ACES
  notoriously skews bright blues and cyans toward purple exactly where the
  glow is strongest — AgX keeps every community's hue honest inside its own
  halo.

- **A cinematic finish over every frame.** Real anti-aliasing (the scene
  renders through HDR buffers that bypassed the browser's AA entirely), plus a
  film grade: fine animated grain that also kills gradient banding around glow
  cores, a soft vignette, a whisper of chromatic aberration at the corners, and
  anamorphic lens streaks across the brightest hub cores. One "Cinematic
  finish" toggle; grain freezes under reduced motion.

- **One-tap looks.** A new "One-tap looks" row in Graph settings changes the
  graph's entire personality with a single tap — Living galaxy, Sigma board,
  Cosmic web, Neural, Planetarium, Paper atlas, Chronicle, Meaning nebula. Each
  bundles a skin, a layout and that layout's research-tuned recommendations.

- **A Sigma skin — the classic graph-viz board.** Flat vivid discs and a
  coloured edge veil on charcoal, no glow, edges curving like the sigma.js
  hairball: saturated community colour as a crisp PICTURE of the vault rather
  than a night sky. Planet spheres and glow effects stay out of its way.

- **The Semantic map is now a 3D meaning-nebula, and two new 3D layouts land:
  Celestial sphere and Radial orbit.** Semantic gains a third principal
  component for depth — orbit the nebula of meaning instead of reading a flat
  chart. "Celestial sphere" puts every note on one star globe, each topic a
  constellation patch with its hubs at the centre — fly inside for a
  planetarium. "Radial orbit" arranges the vault as a solar system around its
  heaviest hub: link-distance shells outward, disconnected notes in the
  farthest orbit. Nine layouts total — six of them 3D.

- **Every layout now has research-grade recommended settings.** The ✦
  Recommended button covers all seven layouts with a per-layout bundle tuned to
  what each form actually reads by: the spiral keeps luminous community arms,
  the timeline and semantic maps become still, print-like charts (all effects
  off, deepened community dots), and two research-verified corrections landed —
  the atlas no longer over-darkens its dots on the dark theme, and both 2D maps
  now take their structure from topic communities rather than the one dominant
  folder. Guard rails keep a layout's recommendation from silently changing a
  different layout's tuned look.

- **A Semantic map layout — the vault arranged by meaning.** Notes take their
  position from their embeddings (top-2 principal components of the local
  index), so pages about the same thing sit together even when no link joins
  them, and wikilink edges drape over the meaning-space as the explicit
  structure. Runs entirely on the local index — nothing leaves the machine. No
  index yet? The view falls back to the spiral and tells you to reindex.

- **Two new layouts: Spiral galaxy and Timeline.** "Spiral galaxy" lays the
  vault along the arms of a log-spiral — whole topics stretch contiguously
  along an arm, the biggest anchors the core bulge, and a tilt shows a real
  galactic disc (the Andromeda/M101 form the design references always wanted).
  "Timeline (2D)" charts the vault as time strata: left→right is when each
  note was last touched, each topic gets its own horizontal band — reading the
  chart IS the history of the vault. Files with no known date pin to a thin
  "before memory" column at the far left. Both are instant and deterministic —
  no simulation, the same vault always draws the same picture.

- **The galaxy condenses into being.** Opening the Graph now births the vault:
  stars ease in from a small drift, cluster after cluster, like a nebula
  condensing — once per visit, never on filter changes, and skipped entirely
  under reduced motion.

- **A galaxy chart in the corner.** A minimap inset shows the whole graph from
  above with a marker for where you are and which way you're facing — and
  clicking anywhere on the chart flies the view there. The antidote to getting
  lost in free 3D flight; toggle under Graph settings.

- **Universe bubbles now show their mass.** In the multiverse, a vault packed
  with notes glows with a brighter membrane and a faint inner haze, while a
  near-empty one stays a thin soap film — which world has the substance reads at
  a glance, before any label.

- **The galaxy never freezes.** Once the layout settles, every star drifts
  through a frozen curl field — circulating locally without ever migrating, so
  positions stay readable while the sky stays alive. Sub-pixel by design, stilled
  by the ambient-motion switch and reduced-motion preference, and flat 2D maps
  stay perfectly still.

- **The Cosmic web skin now renders true density.** Edges accumulate into an
  offscreen HDR buffer and colour on a dark-matter-simulation ramp: sparse
  strands deep blue-violet, converging bundles warming through orange, the
  densest cores white-hot. Where filaments overlap, the field genuinely
  brightens — structure paints itself.

- **A new "Cosmic web" graph skin.** The dark-matter-simulation look: notes
  shrink to pale points of starlight and the links carry the picture — thin
  violet filaments that genuinely brighten where strands overlap, so the
  structure paints itself as a density field. Planet spheres and the coloured
  edge-signal particles stay out of this skin's way. Pick it under Graph
  settings → Color mode.

- **The multiverse now feels like space, not a diorama.** The deep starfield
  rides with the camera, so the sky is star-filled in every direction at any
  zoom — vault bubbles can never drift past the edge of the backdrop again. The
  sky is denser out there, and each universe membrane now breathes gently on its
  own rhythm (still under the ambient-motion/reduced-motion switches).

- **Each vault's galaxy now glows in its own colour.** In the multiverse view a
  galaxy's stars are tinted to match its bubble, so at a glance you can tell which
  cluster of stars belongs to which vault — instead of every galaxy sharing the
  same by-topic colours. The tint uses the exact hue the bubble already uses.

- **A Tasks view gathers every checkbox in your vault.** Any `- [ ]` / `- [x]`
  item in any note now shows up on a new Tasks page — open items first, completed
  ones tucked into a collapsible section — and clicking one jumps to the note it
  lives in. Read-only for now: you check things off where they live. `raw/`
  sources and code samples are skipped.

- **Ingest now updates existing pages instead of duplicating them.** Before the
  ingest agent runs, Memex matches the new source against your existing wiki
  (semantic search over the local embedding index) and steers the agent to the
  pages it most likely relates to — so a follow-up conversation extends the
  page you already have rather than creating a near-duplicate. The Ingest panel
  shows which pages were matched. When no index exists yet, ingest works exactly
  as before.

- **Ingest shows its plan before it writes.** A quick read-only planning pass
  turns the source into an explicit list of what it will do — add a new page,
  update or merge into an existing one, or skip a topic that is already covered —
  colour-coded in the Ingest panel, and handed to the agent as the plan to
  follow. If the planner is unavailable it falls back to the matched-pages list.

- **See which conversation a page came from.** The Provenance page now shows,
  under each page, the sources it cites — resolved from every `[^src-…]` citation
  back to the original. A source imported from an AI conversation shows its
  provider (ChatGPT, Claude.ai, Claude Code, Codex), the conversation id and the
  date; a hand-written source shows its title; a citation whose source file is
  gone is flagged. Nothing new is recorded at import time — this reads provenance
  that was already being kept.

- **Re-sweeping your sessions is now near-instant.** The import ledger remembers
  each session file's size and modified-time, so a second sweep skips every
  session that hasn't changed without re-reading or re-parsing it — only new and
  grown sessions are processed. The "already imported" count stays accurate.

- **Remove a local model from Settings.** The installed-model list under
  Settings › Connections › Ollama now has a remove button on each model, with an
  inline confirm, so a mistakenly pulled multi-gigabyte model can be freed
  without dropping to a terminal (`ollama rm`). The delete goes straight to the
  local daemon; the list refreshes when it is gone.

- **New notes start as real wiki pages.** Creating a page now seeds the required
  frontmatter (type, tags, created, confidence, status) and a title, so a
  hand-made note is visible to Views, the gap report and the graph's colour
  encoding from the moment it exists — instead of being invisible until an LLM
  rewrote it. Daily notes and files under raw/ keep their own format.

- **Import your AI conversations.** Ingest → Import a conversation takes a ChatGPT
  export, a Claude.ai export, or a Claude Code / Codex session and turns each
  conversation into a wiki source. Memex detects the format from the file itself,
  keeps only the real discussion (dropping tool output, sub-agent chatter and
  internal reasoning), and — importantly — holds back any conversation whose text
  looks like it contains a secret (an API key or token) so it never lands in your
  vault. Re-importing the same export is safe: a dedup ledger skips conversations
  already imported, adding only new and changed ones.
- **Import every session on your machine in one click.** Beside the file picker,
  "Import my Claude Code sessions" / "Import my Codex sessions" sweep
  ~/.claude and ~/.codex and import them all, dedup-safe.
- **Bulk import shows its work.** A sweep of thousands of sessions now shows a
  progress bar and a running imported/skipped/failed tally instead of a frozen
  button, lists the sessions that could not be read, and offers "retry failed"
  that re-reads only those — not the whole sweep.
- **Any model id is selectable.** The model field accepts free text (with the
  known list as suggestions), so a model that ships after this build can be used
  without waiting for a release.
- **Clicking a red [[link]] creates the note** — in Ask and the agent panel too,
  not just the editor, and the new page starts with real frontmatter.

### Fixed

- **The multiverse's starry backdrop now spans the whole field.** The deep-field
  stars were a fixed sphere around the origin, so once vaults were spread far
  apart they showed as a ball of stars in the middle with the outer galaxies
  floating on pure black. The starfield is now centred on the field and scaled to
  reach past the farthest galaxy, so stars sit behind every vault. Single-vault
  graphs are unchanged.

- **Entering a universe no longer switches off your Multiverse toggle.** Flying
  into a bubble drops you into that vault's graph, but the saved Multiverse
  preference now stays on — it's a transient view change, not a silent edit of a
  stored setting. Re-assert the toggle (or Reset) to pop back to the bubble field.

- **Connections settings no longer overflow on a narrow window.** On a phone-width
  layout the provider cards pushed their Connect button off the right edge; the
  card now lets its middle column shrink and wraps the status chips, so nothing
  is clipped at 375px.

- **Japanese and Korean are complete.** ja was missing 99 of the app's strings
  and rendered English for the graph inspector, Views, the help widget, Zotero
  import and more; ko was five short. Both now translate everything, and a test
  keeps them from drifting.
- **Dropping several files into Ingest says so.** It loads the first — the form
  takes one source at a time — instead of silently discarding the rest.
- **Auto-ingest never deletes your source.** A consumed inbox file is moved to
  `_inbox/.archived/`, matching the headless daemon, so a half-failed run cannot
  lose the original.
- **Ollama status no longer misreports.** A daemon that answers with an
  unreadable body is shown as an error, not as "running with zero models" — which
  would tell you to pull a model you already have.
- **The ingest history rows are screen-reader-correct.** Each row was one button
  with a link nested inside it; it is now three separate, properly-named
  controls, with the layout unchanged.
- **The two audio-overview hosts sound different from the first play.** They used
  to share one voice until a replay, on the engine Memex actually ships.
- **Zooming into the multiverse glides instead of snapping.** The view no longer
  jumps when the nearest vault changes as you scroll in.
- **Atlas's Recommend no longer disturbs the galaxy layout.** It was writing a
  value the galaxy reads and atlas ignores.
- **The command palette works without a mouse.** It had no dialog role and no
  focus trap, and its keys were bound to the search box — so one Tab away, both
  arrows and Escape stopped working and further tabs walked focus onto the page
  behind it. The selected row is also visible again: it is a button, and an
  inline background reset had been quietly overriding the highlight, in both
  themes. Screen readers now announce the selection instead of nothing.
- **The account panel, crash screen and empty-response text follow your
  language.** A fresh install is Korean, and Settings › Account rendered its
  header translated above English labels.
- **Ingesting a source can no longer start twice.** With auto-ingest on, two
  triggers arriving together (a clip landing on an interval tick) could each
  start an agent against the same vault, doubling edits and token spend, with
  the second run impossible to cancel from the UI.
- **A timelapse recording is no longer lost** when you navigate away or change a
  graph setting mid-record. You get the partial clip instead of no file and no
  error, and the canvas capture is released when a recording ends.
- **Re-opening the multiverse shows your vaults as they are now.** From the
  second visit on, every bubble kept the star field from the first — so notes
  added while you were inside a vault never appeared until a restart.
- **Links containing shell metacharacters can no longer run commands on
  Windows.** External links were opened through `cmd`, which read `&` in a URL
  as the start of another command; a link in a clipped or synced note was enough.

### Performance

- **Opening the Graph builds the scene once instead of twice**, halving the
  WebGL and worker setup on every visit.

- **The bundled MCP server now requires a token.** It runs on localhost for the
  life of the app and exposes tools that write to your vault and make git
  commits — with no credential, any other program on your machine could drive
  them. The app mints a token each launch and the registration line it shows you
  carries it. (Re-register after an update; the command in Settings › MCP is
  always current.)
- **Memex Pro no longer sends your password or license key over plain http.**
- **Ask tells you what it is doing.** The waiting animation used to pulse a
  random sample of your pages under "searching the wiki…" — it now names the
  pages it actually retrieved, and says nothing about pages when there was no
  index to search.
- **Related notes explain themselves when the index is missing** instead of
  silently not appearing — which looked identical to a note having no relatives.
- **A web clip is ingested right away** when auto-ingest is on, instead of
  waiting for the next pass (up to an hour).
- **A reindex survives leaving Settings**, and can no longer be started twice
  against the same index.
- **Renaming a page no longer edits the sources that cite it.** `raw/` is
  read-only by rule, but a rename rewrote wikilinks everywhere in the vault —
  including inside the source documents your wiki cites. A citation is only worth
  something if the thing cited didn't move underneath it.
- **Typing Korean, Japanese or Chinese no longer submits half-composed text.**
  The Enter that commits an IME candidate was being treated as "send": it
  submitted partial questions to the model, activated the wrong command-palette
  row, and closed dialogs early.
- **One unreadable file no longer blanks the whole graph.** A dangling symlink,
  an un-downloaded iCloud placeholder or a single permission-denied note used to
  abort the entire link graph, so the Graph view and every multiverse bubble
  rendered nothing.
- **The vault boundary now holds against symlinks.** A symlinked folder inside a
  vault let search, the context sent to the model, and the embedding index read
  files from outside it — and let a page rename write to them.
- **Multiverse bubbles are now labelled readably in both themes, and you can see
  more than one at a time.** A universe's name — the one thing a bubble exists to
  tell you — was hardcoded near-white (invisible on the light theme) and drowned
  out by the community names that surface while zoomed out. The vaults were also
  spaced as if a big one occupied far more room than it draws, which pushed the
  others out of frame; they now sit a couple of bubble-widths apart.
- **Reindexing no longer crashes the app on a long unbroken paragraph.** A page
  with no headings and no blank lines came back from chunking as a single chunk
  of the whole page — the size limit was only ever applied between paragraphs, so
  text without any was never split (measured: 6,419 characters from an 1,800
  character limit on real Korean prose). Embedding that chunk then killed the
  process outright, because mean pooling needs the whole sequence in one batch
  and anything past 512 tokens was being decoded in pieces. Chunks are now hard
  split at the limit (preferring word breaks, never splitting a character), and
  the embed batch is sized to its text.

### Added

- **Optional: keep the semantic index up to date automatically.** Settings ›
  Semantic search gains a toggle — while Memex is open, pages you edit are
  re-embedded once you stop typing, so semantic search, related notes and graph
  similarity stop describing the vault as it was at your last manual reindex.
  Off by default, and it only maintains an index you already built.

### Changed

- **The app no longer stalls on a large vault.** It was rebuilding the entire
  link graph every four seconds to notice outside edits — reading and parsing
  every note, roughly 300 ms on a 10,000-note vault, forever, almost always to
  conclude nothing had changed. It now checks a cheap fingerprint first and only
  rebuilds when something actually moved.
- **The semantic layer got dramatically faster.** The embedding index is now
  kept in memory between commands and stored in a compact binary format
  (previously every semantic search re-read and re-parsed a JSON file — at
  10,000 chunks that was ~290 ms of parsing to run a 12 ms search). Graph
  similarity edges compute ~10x faster and are cached per index revision.
  Long reindexes save a checkpoint every 30 seconds, so quitting or crashing
  mid-index no longer discards everything, and embedding reuses one model
  context per page (~25% faster). Existing indexes migrate automatically on
  the next reindex.

- **Reindex tells you what it is doing.** Building the embedding index is the
  slowest thing Memex does — roughly half a second per chunk, so minutes on a
  real vault — and it used to run behind nothing but a greyed-out button. It now
  shows a live count and progress bar with the page being indexed, and the first
  run says **"Loading model…"** while the bundled model loads (up to ~12 seconds
  on a cold start) instead of appearing frozen. Settings also fits a phone
  properly: its tab rail becomes a scrolling row below 768px rather than pushing
  the page sideways.
- **MYCO grows into the app (Phase 1).** A quiet **"?" help widget** sits in
  the bottom-right corner — it never animates, never opens itself, never
  interrupts (pull, not push): clicking it opens a small panel where MYCO
  greets you next to tips for the current page and the global shortcuts. The
  Ask page's empty chat now welcomes you with the mascot instead of a blank
  pane, the onboarding wizard's step icon became MYCO, and Settings ›
  Appearance gains a **"Show MYCO" master switch** — off swaps every mascot
  slot for the static logo (the full opt-out that character UX research says
  any mascot needs, on top of the existing `prefers-reduced-motion` fallback).
- **Web clipper.** A `memx://clip?url=&title=&selection=` deep link drops the
  current browser page into the vault's `_inbox/` as a markdown source doc —
  a minimal MV3 extension and a bookmarklet live in `clipper/`. The Rust
  handler treats every clip as hostile input (http(s)-only source URLs,
  length caps, control-char stripping, whitelisted slug filenames confined to
  `_inbox/`), notifies on save, and falls back to the persisted active-vault
  marker when the link arrives before a vault is opened. Scheme registration
  happens at bundle install — dev builds don't receive `memx:` links on macOS.
- **Zotero import.** The Ingest page gains an *Import from Zotero* card:
  drop a CSL-JSON or BibTeX export (PDF highlights come along when the export
  carries annotations) and every item is written into `_inbox/` as a markdown
  source doc — title, authors, year, DOI, quoted highlights — ready for the
  normal ingest pipeline to turn into cited wiki pages. Tolerant client-side
  parsing (salvages what it can, never throws), unit-tested.
- **Suggested links — an accept/reject queue for the embedding pairs.** The
  Overview page now surfaces the semantically-closest note pairs that are NOT
  yet wikilinked. Accepting one appends the `[[wikilink]]` under the source
  note's `## Related` section (read → append → write, frontmatter preserved)
  and refreshes the link graph; dismissing remembers the pair. The AI only
  proposes — nothing is ever inserted without a click.
- **Query views — a Dataview-lite over the wiki's frontmatter.** A new
  **Views** page filters every page by the structured metadata the scanner
  already extracts — type, confidence, status, tags, source count, orphans,
  name — with sortable columns (sources / links / type / name) and one-click
  saved views (localStorage) for the lenses you keep coming back to. Facet
  dropdowns only offer values that actually exist in the vault. Pure,
  unit-tested engine (`queryViews.ts`) over the in-memory adjacency — no
  backend, no query language to learn.
- **Research bridges — cluster-level gap analysis.** The graph's Gaps panel
  now opens with a *Research bridges* section: pairs of topic clusters whose
  notes are semantically close (per the embedding-similarity pairs) but share
  zero `[[wikilinks]]` — the clusters of thinking that aren't talking to each
  other yet. Each bridge names the two clusters by their hub notes, draws a
  dashed hint line between the cluster centroids in the 3D scene while the
  panel is open, and carries an *Ask about this gap* action that drafts a
  bridging research question straight into the Ask page. Pure, unit-tested
  aggregation (`clusterBridges`) over the live graph — no new backend.
- **Near-field planet LOD.** A new *Near-field planets* graph toggle: fly in
  close and the notes nearest the camera resolve from glowing star points into
  procedural planets — 20 shader families (terran, ocean, lava, gas giant,
  frozen, crystal, …) seeded per note and tinted by community hue, with rings
  on giants and small orbiting moons. Hubs read as gas/storm giants,
  super-connected notes turn molten, orphans go barren. Everything is
  instanced (spheres + rings + moons ≈ three draw calls, capped at 24 live
  worlds), gated to dark 3D layouts, and honors reduced motion by freezing
  spin while still rendering.
- **MYCO, the Memex mascot.** The mushroom mascot now lives in the app as a
  transparent alpha-video sprite (`MascotClip`): it idles on the Settings ›
  About card and keeps the graph's loading screen company. Ships dual-codec
  alpha video (HEVC `hvc1` for the WKWebView shell, VP9 WebM for Chromium dev
  browsers), falls back to a still poster under `prefers-reduced-motion` or
  playback failure, and crops the wide clip to a square around the character.

- **Multiverse — a graph mode, not a separate page.** The Graph view's settings
  drawer (Display › Multiverse) gains a toggle: turn it on and, instead of this
  one vault, every registered project appears as its own **glowing universe
  bubble** floating in one shared cosmos — a translucent fresnel sphere with its
  star cloud visible inside, each a distinct rank-spread colour with the
  project's name floating above it, placed far apart so the field reads as many
  separate orbs. Click a bubble and the camera
  **flies into it**, arriving among that project's stars right as it becomes the
  active vault (registry pointer + confinement) and the view settles into its
  normal graph. Backed by a dedicated `multiverseStore` (lazy, parallel
  per-universe loading, kept separate from the single-vault store) and a pure,
  unit-tested core (`buildMultiverseGraph` merges each project's link graph with
  per-universe node tagging and namespaced ghost links; `universeAnchorsBySize`
  + `layoutMultiverse` separate each subcloud; `UniverseBubbleLayer` draws the
  membranes). The 3D scene reuses the existing cosmic renderer statically (no
  per-universe force sim). Verified across the three standard viewports.
- **Multiverse groundwork (Phase 0).** The Rust backend can now enumerate the
  multi-project registry (`projects.json` discovered above the open vault) and
  build read-only link graphs for any registered project — not just the open
  vault — via new `list_projects` / `build_link_graph_at` IPC commands.
  `set_active_project` switches the active project (registry pointer,
  confinement root, MCP marker) without the full `open_vault` teardown. Slug
  validation and symlink containment mirror the Python registry's defenses;
  every mutating command keeps the single-vault confinement.

## [0.2.2] - 2026-07-13

### Fixed

- **Large graphs no longer lag or load blank.** The cosmic-scale LOD had its
  thresholds inverted — the default framed view sat in the galaxy-imposter
  band, so a big vault faded its node cloud to zero and showed only discs +
  labels (reading as a frozen black screen). The framed view (and closer) now
  shows the actual node graph; galaxy imposters are a pull-back effect. The sim
  worker also throttles its position posts to ~30Hz and the main thread
  coalesces them to one apply per frame, so the settle no longer saturates the
  event loop, and imposters stop rendering when fully zoomed in.


## [0.2.1] - 2026-07-13

### Cosmic-scale LOD

The Graph now renders at true cosmic scale. Pull the camera back and the node
cloud fades out while each galaxy resolves into a procedural barred-spiral disc
(warm core, log-spiral arms with dust mottling, slow rotation, hue from the
galaxy's hub, sized to its world radius); fly in and the discs fade out as the
individual stars, edges and labels fade back in. A HUD badge names the altitude
as you cross scale bands — star → star system → galaxy → galaxy cluster. This
also fixes the "white blob" a 10k-node vault showed in performance mode: the
imposters stay on (one cheap draw call), so a huge vault zoomed out reads as a
majestic cluster of galaxies, and the more nodes the grander the discs.


## [0.2.0] - 2026-07-13

### Graph universe overhaul

The Graph view is now a living universe. **Folder galaxies** (default on):
notes group by parent folder (Louvain fallback on flat vaults), each group is
pulled to its own anchor on a vast flattened shell and squashed onto a seeded
tilted disc plane — several separate spiral-ish galaxies with a pulsing
Andromeda-style core bulge, a faint white dust band (large galaxies only), and
a slow per-galaxy rotation. Densely interlinked folders swell into bigger
galaxies; isolated notes orbit their nearest linked star as moons. **Stellar
classes**: every note renders as one of four seeded star types (main sequence,
dwarf, red giant, neutron star with diffraction spikes) so the sky reads as a
population. **Graph-only color mode** (auto / black / white / galaxy skins)
independent of the app theme. **Motion**: click a node for a supernova +
neural activation wave rippling through its BFS rings, idle synapse
micro-firings, ambient meteors, and rare random **black hole / wormhole**
events. **Spaceship mode** now flies a real CC0 hull (Quaternius) with
inertial flight physics, banking, an engine particle trail and a HUD speed
readout. **Timelapse** gains a 0.25×–4× speed slider (live mid-replay) and no
longer leaves a ghost web behind on light themes.


### Embedded local model (built-in offline provider)

The app now ships with a model inside: **Gemma 3 1B instruct** (Q4_K_M GGUF,
769 MB, git-lfs; © Google, Gemma Terms of Use bundled) runs in-process via
llama.cpp (`llama-cpp-2`, Metal on Apple silicon) — no Ollama install, no API
key, works offline. Registered as the
always-on **Built-in (offline)** provider: Query/Lint route to it with inlined
vault context; a `local_classify` command post-validates note types against the
wiki enum. Chosen over Qwen2.5-0.5B after a spike (Qwen leaked Chinese
characters into Korean output); factual accuracy is limited at 0.5B, so
high-quality ingest stays on the cloud/CLI providers. License verified: the
HyperCLOVA X SEED Model License permits redistribution; the verbatim license
ships next to the weights and the provider card shows "Powered by
HyperCLOVA X". Installer grows accordingly (~3.6 MB → ~420 MB).

### 3D graph — cosmic-web rendering

The long-running graph layout churn is settled: the force-directed layout stays
(node position encodes link structure) and the procedural spiral-galaxy spec is
superseded. See `app/docs/specs/2026-06-27-cosmic-web-graph.md`.

- **Background starfield is enabled.** The faint multi-shell parallax field gives
  the cosmic-web depth (previously built but disabled).
- **Hub-incident edges render as fat glowing filaments.** A bounded
  `LineSegments2` overlay (capped by combined endpoint degree) draws luminous
  strands between community cores on top of the thin edge mesh; they brighten on
  hover and vanish for timelapse-hidden nodes. The cap keeps fat lines — heavier
  than 1px lines — from blowing up the frame on dense vaults.

### Security audit hardening

A full multi-agent security review of the codebase produced these fixes (each
finding was adversarially re-verified against the source):

- **Ingest no longer pre-authorizes the agent's `Bash` tool.** The Claude CLI
  ingest reads untrusted `raw/` source content in non-interactive `--print`
  mode, so the default tool set is now `Read,Write,Edit,Glob,Grep` — a
  prompt-injection payload in a source can no longer reach a shell.
  `MEMEX_CLAUDE_TOOLS` still overrides it.
- **PDF / spreadsheet parsing is isolated in a child process.** pdf-extract and
  calamine run on untrusted bytes under `panic = "abort"`; a parser panic/OOM
  used to crash the whole app. `read_external_text` now parses via
  `memex --extract-text <path>`, so a crash/timeout becomes a normal error. The
  extracted output is capped and the cell walk bounded (xlsx zip-bomb defence).
- **`read_file` rejects pathologically deep YAML frontmatter** before parsing
  (and `pod_to_json` caps recursion), so adversarial nesting can't overflow the
  stack; large files are size-guarded.
- **HTTP provider clients no longer follow redirects** (the `x-api-key` /
  `x-goog-api-key` headers can't be replayed to another host), and a
  `MEMEX_*_URL` override now requires https except for loopback hosts, so a
  plaintext-http override can't leak a key in cleartext.
- **The read-only vault scanners** (`list_files`, `file_mtimes`,
  `read_vault_context`, `build_link_graph`, `scan_provenance`, `git_log`) are
  confined to the open vault root like the mutating commands, and skip files
  over 2 MB.
- **MCP `create_page` / `list_pages` confine the `folder` argument** and the
  project registry validates each `slug`, so neither can escape `wiki/` or
  `projects/` via `..` / an absolute path.
- **CSP `img-src` no longer allows bare `https:`**, so a vault note can't beacon
  to a remote host on render (local/embedded/vault images still load).
- **The autosave flush on navigation** compares against a component-local
  baseline, so a rename/interleaved open can't drop keystrokes typed in the
  debounce window.
- Provenance coverage no longer counts footnote-definition lines as claims (it
  was inflating every page toward 100%).
- CI now runs `cargo audit` + `npm audit` (shipped deps) and Dependabot watches
  cargo/npm/actions; markdown-it bumped to 14.2.0 (smartquotes-DoS advisory).

### Security & robustness

- **Content-Security-Policy is now enabled** (was `null`). The policy restricts
  the webview to self-hosted code plus the exact runtime dependencies the app
  needs — Tauri IPC, the asset protocol, the bundled sim Web Worker, inline
  styles, the local Ollama daemon fetch, and the Google Fonts it loads — so a
  crafted vault page can no longer pull in arbitrary external resources or
  scripts. Verified in the built desktop app: the vault, styles, fonts, and the
  worker-driven 3D graph all render under the policy.
- Provider base URLs from `MEMEX_*_URL` env overrides are honoured only when
  they are http(s), falling back to the production URL otherwise (SSRF guard).
- The MCP server's `git_commit` aborts with an error if `git add` fails instead
  of silently committing a stale/partial staging set.
- HTTP provider responses are now size-capped (32 MB) so a hostile/buggy
  endpoint can't OOM the app, and chat calls retry transient failures
  (network error / 429 / 5xx) with backoff — without retrying 4xx auth errors.
- `open_external` now only launches http(s)/mailto URLs or existing local
  paths, rejecting arbitrary schemes (javascript:, data:, …).
- `settings.json` and the active-vault marker are written atomically
  (temp + fsync + rename); `write_file` now also fsyncs the parent directory,
  so a crash mid-write can't corrupt or lose them.
- The streaming Claude run writes stdin on a thread concurrent with the stdout
  drain, so a large ingest prompt can no longer deadlock on the stdin pipe.

### Accessibility

- Modal dialogs: `role="dialog"`/`aria-modal` on the dialog (not the backdrop),
  focus moved into the dialog on open and restored on close, a Tab focus trap,
  Escape-to-close, and the previously hardcoded English buttons are translated.
- The ⌘K command palette is navigable with Up/Down arrows (Enter opens the
  selected row).
- The provenance coverage bars no longer signal status by colour alone — each
  shows its percentage and a "below threshold" badge.
- The Ollama setup card is now fully localized (was hardcoded English).

### Performance

- **The 3D graph simulation now runs in a Web Worker**, off the main thread. A
  10k-node settle (and every drag / slider reheat) used to freeze the UI for the
  whole layout — each force tick blocked the thread ~120 ms and the freeze grew
  with node count. The physics is now off-thread; the main thread only applies
  the posted positions. Measured on the 10k-node hero mesh: settle frame rate
  18.7 → **60 fps**, worst main-thread block 137 ms → **25 ms**, and 100 ms+
  freezes 55 → **0**. The galaxy layout is byte-for-byte identical (same forces).
- Graph nebula centroids are computed in O(nodes) (was O(communities × nodes))
  with cached colours, trimming per-tick cost on large vaults.
- **Graph hover picking is coalesced to one pick per frame** instead of one per
  `pointermove`. Picking projects every node, so on a fast mouse move (100-120
  events/s) it flooded the thread; a 60-move burst now costs ~0.4 ms (was
  hundreds) and hovering an 11k-node graph holds 60 fps.

### Fixed

- **Misleading provider status:** a CLI provider (e.g. the Claude CLI, which is
  enabled by default) showed "Connected" purely from the saved enable flag, so on
  a machine without the CLI installed it claimed to work while ingest/query
  failed. CLI provider cards now reflect the live install check and show
  "CLI not installed" when the binary can't be found.
- The markdown viewer's `[[wikilink]]` parser now matches the same links as the
  graph/backlinks parser (e.g. `[[a]b]]` is consistently a non-link), so the
  rendered page and the graph no longer disagree about whether a link exists.
- Settings writes that fail on disk now surface an error instead of silently
  desyncing the UI from what's persisted.
- **Data loss:** editing any page with YAML frontmatter and letting autosave
  fire silently erased the entire frontmatter block. `read_file` now returns the
  full raw document; the editor round-trips it losslessly while the preview
  still hides the frontmatter. Covered by a Rust round-trip regression test.
- **Autosave** could drop the newest keystrokes when navigating right as an
  in-flight save resolved; it now flushes any unsaved edit on navigation.
- **Rename** now rewrites inbound `[[wikilinks]]` vault-wide (alias/section
  preserved), so renaming a note no longer orphans its backlinks and graph edges.
- **Security:** filesystem IPC commands are confined to the open vault root — a
  crafted call can no longer read/write/delete files outside it. The Gemini API
  key now travels in a header instead of the URL, so it can't leak into error
  strings.
- **A11y:** the graph "Show orphans / Existing only / Arrows" toggles are real
  keyboard-operable `<button role="switch">`s instead of unfocusable spans.
- **Agent CLI hangs:** codex/gemini runs now drain stdout/stderr concurrently
  with the stdin write (and reap the child on timeout), so a verbose agent can no
  longer deadlock on its stdout pipe and hang until the 600s timeout.
- **Responsive:** added a <=768px breakpoint — the sidebar becomes an off-canvas
  overlay and columns stack, so nothing overflows horizontally on phones/tablets
  (verified at 375 / 768 / 1280).

### Added

- **Memex Pro provider** (Settings → Connections): a managed ingest option that
  runs a cheap model server-side and applies the returned wiki pages locally —
  no API key or CLI needed. You **sign in with your Memex Pro account** (the one
  created on the website); the app fetches and stores the account's access key
  automatically — no key to copy by hand. The `memex_pro_ingest` command then
  POSTs the vault snapshot and applies the returned file operations through the
  confined `write_file`; `memex_pro_login` / `memex_pro_logout` manage the session.
- **In-app auto-ingest toggle** (Settings → Model): while Memex is open, it
  periodically ingests sources dropped into the vault's `_inbox/` via the
  selected provider (a configurable interval). Complements the headless cron
  daemon; both watch the same `_inbox/`.
- **Scheduled auto-ingest** (`automation/autoingest.py`): drop sources into the
  vault's `_inbox/` and they're ingested into the wiki automatically on a
  schedule (cron / launchd), using your own `claude` CLI. New `raw/<slug>.md`
  files are created (raw/ stays immutable), originals are archived to
  `_inbox/.archived/`, and each pass is logged. The ingest agent runs without
  `Bash` since inbox content is untrusted.
- **MCP inbox tools** (`list_inbox`, `read_inbox_source`, `archive_inbox_source`):
  a terminal-connected Claude can continuously ingest the `_inbox/` backlog using
  its own read/write tools — read a pending source, write the wiki pages with
  citations, then archive it.
- **Choose the Claude CLI model** (Settings → Model): the CLI run now passes
  `--model`, so ingest/query can run on a cheaper model. Defaults to Haiku for
  ingest (high volume) and Sonnet for query.
- **Ingest PDF, XLSX/XLS/ODS, and CSV files** — they're extracted to text
  (pdf-extract / calamine) before ingestion. Scanned/image PDFs report a clear
  "OCR not supported" message.
- **Full-text search** in the ⌘K command palette: matches inside page contents
  now appear alongside name/route matches, each showing the file and the
  matching line. Backed by a new vault-confined `search_vault` command.
- A top-level React error boundary (plus one around the 3D graph) so a render
  throw shows a recoverable card instead of blanking the whole window.
- Frontend unit test suite (vitest): stripFrontmatter, wikilink parsing/escaping,
  graph filter algebra, deterministic seeding, and time formatters.
- `ci.yml` gating eslint, `tsc`, vitest, `cargo fmt`/`clippy`/`test` (Linux and
  Windows) on every push and PR — previously CI only ran on release tags.

## [0.1.0] - 2026-06-21

First public installer release of Memex — a cross-platform desktop wiki for
plain markdown vaults. Supersedes the 2026-05-09 internal MVP build.

### Added

- Prebuilt installers: macOS universal `.dmg` (Apple Silicon + Intel) and
  Windows x64 `.exe` (NSIS), built in CI via `tauri-action`.
- Tauri 2 + React 18 + Vite 5 + TypeScript 5 application shell.
- Vault IPC: `open_vault`, `list_files`, `read_file`, `write_file`
  (atomic via tempfile + rename), `parse_links`, `build_link_graph`.
- Sidebar with collapsible folder tree and resizable splitter
  (200–600 px), state persisted to localStorage.
- CodeMirror 6 markdown editor with `⌘S` save and 2 s autosave debounce.
- markdown-it preview with custom `[[wikilink]]` rule rendering
  `<a data-link>` for app-level click resolution.
- Source / Preview / Split (50/50) view-mode toggle.
- Backlinks panel powered by the cached link graph.
- 3D vault Graph view (three.js + d3-force) with tag/folder filters,
  click-to-open, and a growth timelapse.
- Tauri dialog plugin for directory picking; last vault path persisted
  across launches.

### Changed

- The 3D vault Graph now renders as a cohesive galaxy/brain — range-capped
  local repulsion plus Louvain community clustering — instead of the radial
  "firework" explosion. Ships a new `galaxy` default preset and stays usable
  on 10k+ node vaults. (The original MVP graph used Cytoscape.js + fcose.)

### Notes

- Installers are unsigned for this release. macOS Gatekeeper ("unidentified
  developer") and Windows SmartScreen ("Windows protected your PC") warn on
  first launch; right-click → Open (macOS) or More info → Run anyway (Windows)
  to proceed.
