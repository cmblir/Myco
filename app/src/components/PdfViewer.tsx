// In-app PDF viewer (Feature 6). Renders a raw/ PDF with pdf.js (bundled, local
// worker — no CDN), one page at a time (prev/next), with a text layer for
// selection. Selecting text shows a "Highlight & cite" toolbar that mints an
// anchor into the sidecar (wiki/.annotations/<stem>.json) and inserts a
// [[pdf::…]] pinpoint link into the citing note. Sidecar highlights re-render
// as overlay boxes; clicking one opens the citing note. raw/ is never written.

import { useEffect, useRef, useState, useCallback } from "react";
import type { JSX } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import { usePdfStore } from "../stores/pdfStore";
import {
  loadSidecar,
  saveSidecar,
  makeAnchorId,
  type Anchor,
  type Sidecar,
  type Quad,
} from "../lib/annotations";
import { formatPdfLink } from "../lib/wikilinks";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const COLORS = ["#ffd54f", "#81c784", "#64b5f6", "#e57373"];

export default function PdfViewer({ t }: { t: Strings }): JSX.Element | null {
  const open = usePdfStore((s) => s.open);
  const gotoPage = usePdfStore((s) => s.gotoPage);
  const flashAnchor = usePdfStore((s) => s.flashAnchor);
  const close = usePdfStore((s) => s.close);
  const vaultPath = useVaultStore((s) => s.currentVault?.path);
  const setRoute = useUIStore((s) => s.setRoute);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const pageWrapRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const taskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(gotoPage);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidecar, setSidecar] = useState<Sidecar | null>(null);
  const [sel, setSel] = useState<{ quads: Quad[]; text: string } | null>(null);
  const [pageBox, setPageBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Load the document + sidecar when the target PDF changes.
  useEffect(() => {
    if (!open || !vaultPath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPage(gotoPage);
    void (async () => {
      try {
        const buf = await ipc.readRawBytes(open.relpath);
        const task = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
        taskRef.current = task;
        const doc = await task.promise;
        if (cancelled) return;
        docRef.current = doc;
        setNumPages(doc.numPages);
        const sc = await loadSidecar(vaultPath, open.stem, open.relpath);
        if (!cancelled) setSidecar(sc);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      void taskRef.current?.destroy();
      taskRef.current = null;
      docRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.relpath, vaultPath]);

  // Render the current page (canvas + text layer).
  const renderPage = useCallback(async () => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    const textLayer = textLayerRef.current;
    if (!doc || !canvas || page < 1 || page > doc.numPages) return;
    const pdfPage = await doc.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1.4 });
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    setPageBox({ w: viewport.width, h: viewport.height });
    await pdfPage.render({ canvas, canvasContext: ctx, viewport }).promise;
    // Text layer for selection.
    if (textLayer) {
      textLayer.innerHTML = "";
      textLayer.style.width = `${viewport.width}px`;
      textLayer.style.height = `${viewport.height}px`;
      const textContent = await pdfPage.getTextContent();
      const layer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport,
      });
      await layer.render();
    }
  }, [page]);

  useEffect(() => {
    if (!loading && !error) void renderPage().catch((e) => setError(String(e)));
  }, [loading, error, renderPage]);

  // Capture a text selection within the page as normalized quads.
  function onMouseUp(): void {
    const wrap = pageWrapRef.current;
    const selection = window.getSelection();
    if (!wrap || !selection || selection.isCollapsed || pageBox.w === 0) {
      setSel(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setSel(null);
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const range = selection.getRangeAt(0);
    const quads: Quad[] = [];
    for (const r of Array.from(range.getClientRects())) {
      quads.push({
        x: (r.left - wrapRect.left) / pageBox.w,
        y: (r.top - wrapRect.top) / pageBox.h,
        w: r.width / pageBox.w,
        h: r.height / pageBox.h,
      });
    }
    if (quads.length) setSel({ quads, text });
  }

  async function mint(color: string): Promise<void> {
    if (!sel || !sidecar || !vaultPath || !open) return;
    const seq = sidecar.anchors.filter((a) => a.page === page).length;
    const anchor: Anchor = {
      id: makeAnchorId(page, sel.text, seq),
      page,
      quads: sel.quads,
      text: sel.text,
      color,
      note: open.citingNote ?? "",
      created: new Date().toISOString(),
    };
    const next: Sidecar = { ...sidecar, anchors: [...sidecar.anchors, anchor] };
    setSidecar(next);
    setSel(null);
    window.getSelection()?.removeAllRanges();
    await saveSidecar(vaultPath, open.stem, next);
    // Insert the pinpoint link into the citing note (append), if we have one.
    if (open.citingNote) {
      const link = formatPdfLink(
        { stem: open.stem, page, anchorId: anchor.id },
        sel.text.slice(0, 40),
      );
      const file = await ipc.readFile(open.citingNote).catch(() => null);
      if (file) {
        await ipc
          .writeFile(open.citingNote, `${file.raw.trimEnd()}\n\n${link}\n`)
          .catch(() => undefined);
        void useVaultStore.getState().refreshLinkGraph();
      }
    }
  }

  if (!open) return null;

  const pageAnchors = sidecar?.anchors.filter((a) => a.page === page) ?? [];

  return (
    <div className="pdf-viewer card" data-testid="pdf-viewer">
      <div className="pdf-toolbar row">
        <b className="pdf-title">{open.stem}</b>
        <div className="pdf-nav row" style={{ gap: 6, marginLeft: "auto" }}>
          <button
            className="btn"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <Icon name="arrowL" size={12} />
          </button>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {(t.pdf_page ?? "p. {n} / {total}")
              .replace("{n}", String(page))
              .replace("{total}", String(numPages || "?"))}
          </span>
          <button
            className="btn"
            disabled={numPages > 0 && page >= numPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <Icon name="arrowR" size={12} />
          </button>
          <button className="btn btn-ghost" onClick={close} aria-label={t.pdf_close ?? "Close"}>
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>

      {loading ? (
        <p className="muted" style={{ padding: 16 }}>{t.pdf_loading ?? "Loading PDF…"}</p>
      ) : error ? (
        <p style={{ color: "#dc2626", padding: 16 }}>
          {t.pdf_error ?? "Could not open this PDF."} {error}
        </p>
      ) : (
        <div className="pdf-scroll">
          <div
            className="pdf-page"
            ref={pageWrapRef}
            onMouseUp={onMouseUp}
            style={{ width: pageBox.w || undefined, height: pageBox.h || undefined }}
          >
            <canvas ref={canvasRef} className="pdf-canvas" />
            <div ref={textLayerRef} className="pdf-textlayer textLayer" />
            {/* Highlight overlays from the sidecar. */}
            {pageAnchors.map((a) =>
              a.quads.map((q, i) => (
                <button
                  key={`${a.id}-${i}`}
                  className={"pdf-highlight" + (a.id === flashAnchor ? " flash" : "")}
                  title={a.text}
                  style={{
                    left: `${q.x * 100}%`,
                    top: `${q.y * 100}%`,
                    width: `${q.w * 100}%`,
                    height: `${q.h * 100}%`,
                    background: a.color,
                  }}
                  onClick={() => {
                    if (a.note) setRoute(`page:${a.note}`);
                  }}
                />
              )),
            )}
          </div>

          {sel ? (
            <div className="pdf-sel-toolbar">
              <span className="muted" style={{ fontSize: 12 }}>
                {t.pdf_highlight_cite ?? "Highlight & cite"}
              </span>
              {COLORS.map((c) => (
                <button
                  key={c}
                  className="pdf-swatch"
                  style={{ background: c }}
                  aria-label={c}
                  onClick={() => void mint(c)}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
