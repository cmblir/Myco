// PDF viewer state (Feature 6). Holds which raw PDF is open and the page/anchor
// to jump to, so a [[pdf::…]] link click anywhere (or a "Source PDF" button) can
// drive the viewer. The heavy rendering + sidecar live in PdfViewer/annotations.

import { create } from "zustand";

export interface PdfOpen {
  /** Vault-relative raw path, e.g. "raw/attention.pdf". */
  relpath: string;
  /** Raw file stem (sidecar key + link stem). */
  stem: string;
  /** The wiki note this viewer session cites into (for minted anchors). */
  citingNote: string | null;
}

export interface PdfState {
  open: PdfOpen | null;
  /** Page to scroll to when opening (1-based). */
  gotoPage: number;
  /** Anchor id to flash on open. */
  flashAnchor: string;
  openPdf: (o: PdfOpen, page?: number, anchorId?: string) => void;
  close: () => void;
}

export const usePdfStore = create<PdfState>((set) => ({
  open: null,
  gotoPage: 1,
  flashAnchor: "",
  openPdf: (o, page = 1, anchorId = "") =>
    set({ open: o, gotoPage: page, flashAnchor: anchorId }),
  close: () => set({ open: null, flashAnchor: "" }),
}));
