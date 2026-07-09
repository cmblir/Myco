# Feature 6 — PDF Annotation via Backlinks — Design

Date: 2026-07-09
Priority: 6. Depends on: none (composes with #1 citations, #2 multimodal ingest).
Scope: `app/src-tauri` (Rust: serve raw PDF bytes, sidecar read/write), `app/src`
(`components/PdfViewer.tsx` new, `PageReader.tsx`, `lib/wikilinks.ts` link parsing,
markdown-it render), `app/src/lib/i18n.ts`.

## Problem / opportunity

Memex ingests PDFs (dropped into `raw/`, text extracted via `extract.rs`) but there
is no way to *read the PDF in-app* or tie a wiki claim back to the exact spot in the
source. Citations today are `[^src-*]` footnotes pointing at a `wiki/source-*.md`
summary — one hop removed from the original page/quote. Obsidian's PDF++ shows the
value: highlight PDF text → a backlink from a note to that precise selection,
rendered as a colour-coded highlight, with click-through both directions. This makes
provenance *verifiable at the source*, reinforcing Memex's citation strength.

## Decisions (proposed — confirm open items below)

- **In-app PDF viewer: pdf.js**, bundled (no CDN), rendered in the WKWebView.
- **`raw/` stays immutable** — the PDF file is never modified. Annotations are an
  **external sidecar overlay**, rebuildable, plain-text (no lock-in).
- **Highlight → backlink**: selecting text in the viewer mints an anchor
  `{ page, quadPoints[], text, color, id }` and inserts a link into the wiki note
  the user is editing; the highlight renders from the sidecar on next open.

## Architecture

### A. PDF viewer (frontend, `components/PdfViewer.tsx` — new)
- `pdfjs-dist` (bundled; worker as a local asset, `disableWorker`/local `workerSrc`,
  no network). Renders `raw/<file>.pdf` page canvases + a text layer for selection.
- Bytes come from Rust, not `file://`: new IPC `read_raw_bytes(relpath) -> Vec<u8>`
  (base64/stream), path-confined to the vault `raw/` (reuse `VaultRoot` guard).
- Overlay layer draws highlights from the sidecar (absolute-positioned divs over the
  text layer, per-page, colour = anchor.color). Click a highlight → open the linking
  note. Selection toolbar: "Highlight & cite" (colour swatches) → mint anchor.

### B. Annotation sidecar (storage)
- One sidecar per PDF, keyed by the raw file: `wiki/.annotations/<raw-stem>.json`
  (a hidden, git-tracked, plain-JSON file — outside `raw/`, so immutability holds).
  Shape: `{ source: "raw/<file>.pdf", anchors: [{ id, page, quads, text, color,
  note: "wiki/<stem>.md", created }] }`.
- Rust IPC: `read_annotations(rawRelpath)`, `write_annotations(rawRelpath, json)`
  (atomic write like `settings.rs`). Frontend `annotationsStore`.
- Alternative considered (open decision): store anchors inline in the linking note's
  frontmatter instead of a sidecar. Sidecar chosen for v1 (one place per source,
  survives note moves, easy highlight render).

### C. Link syntax (wiki note ↔ PDF location)
- New resolvable form: **`[[pdf::<raw-stem>#p<page>:<anchorId>|label]]`** parsed in
  `lib/wikilinks.ts` and rendered by markdown-it as a clickable citation. Clicking
  opens the PDF viewer at that page and flashes the highlight.
- Reconciliation (open decision): keep `[^src-*]` footnotes as the *page-level*
  citation and add `[[pdf::…]]` as the optional *pinpoint* citation, OR teach the
  ingest pipeline to emit `[[pdf::…]]` when it has a quad. v1: additive — pinpoint
  links are hand-made from the viewer; ingest unchanged.

### D. Reader integration (`PageReader.tsx`)
- A "Source PDF" affordance when a page cites a raw PDF: opens `PdfViewer` in a
  split/overlay. Clicking a `[[pdf::…]]` link anywhere routes to the viewer + anchor.
- Reverse direction: viewer highlight → jump to the citing note (from `anchor.note`).

## Constraints fit
- `raw/` PDFs read-only, never written; annotations live in `wiki/.annotations/`
  (external overlay, plain JSON, git-diffable, rebuildable → no lock-in).
- Offline: pdf.js + worker bundled, no CDN/telemetry. Bytes served through the
  path-confined Rust command (no `file://` escape).

## Error handling
- Corrupt/huge PDF → viewer shows an error, never crashes the app; cap render pages
  lazily (virtualize).
- Sidecar missing/invalid JSON → treat as no annotations; never block reading.
- Anchor whose `page`/`quads` no longer resolve (edited/replaced PDF — rare since
  raw is immutable) → show a "location not found" chip, keep the text quote.

## Testing / verification
- Rust unit: `read_raw_bytes` path confinement (reject `../`, non-`raw/`), annotation
  read/write round-trip + atomicity.
- Frontend unit: `[[pdf::…]]` parse/format in `wikilinks.ts`; sidecar
  serialize/deserialize.
- Playwright: open a raw PDF, select text, create a highlight+cite → highlight
  persists on reopen; click the `[[pdf::…]]` link in a note → viewer opens at the
  page; click a highlight → citing note opens.
- `tsc -b`, `eslint`, `vitest run` clean.

## Open decisions
1. Sidecar JSON vs inline-frontmatter anchor storage (spec picks sidecar).
2. Link syntax: new `[[pdf::…]]` vs extending `[^src-*]` (spec picks additive new form).
3. Whether ingest auto-emits pinpoint links or they stay hand-made in v1 (spec: hand-made).
4. pdf.js bundle weight + worker packaging in Tauri (verify no CDN fallback).
