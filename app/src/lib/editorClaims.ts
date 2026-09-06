// Uncited-claim markers: an amber dot in the right margin beside a paragraph
// that asserts something and cites nothing (mockup "Manuscript"). `claimCandidates`
// is the pure heuristic (vitest, node); `claimMarkers` is the CodeMirror
// extension, composed ALONGSIDE editorLive.ts rather than inside it.
//
// The heuristic is deliberately conservative — a missed claim costs nothing, a
// dot on a line that is not a claim is noise on every note. It also accepts a
// WIDER notion of "cited" than provenance.rs does: any `[[wikilink]]`,
// footnote reference, `<cite>` or URL counts here, while the coverage number in
// the rail counts only `[^src-…]`. Different questions: "did you point at
// anything?" vs "is this traceable to a source file?".

import type { Extension } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";
import { frontmatterLength } from "./markdown";

export interface ClaimSpan {
  /** 1-based, inclusive. */
  from: number;
  to: number;
  /** The paragraph's text, for the retrieval query. */
  text: string;
}

/** Sentence terminators, Latin and CJK. A paragraph with none of them is a
 *  fragment (a caption, a stub) rather than an assertion. */
const TERMINATOR = /[.!?。！？]/;
/** Anything that points somewhere: wikilink, footnote ref, cite tag, URL. */
const CITED = /\[\[[^\]]+\]\]|\[\^[^\]]+\]|<cite\b|https?:\/\//;
/** Lines that are structure, not prose. */
const STRUCTURAL = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||!\[|<|\[\^[^\]]+\]:)/;
/** Shorter than this and it is a label, not a claim. */
const MIN_CHARS = 25;

/**
 * Paragraphs that assert something and cite nothing. A paragraph is a maximal
 * block of consecutive non-blank lines; it is skipped when it is inside the
 * frontmatter or a fenced code block, when any of its lines is structural
 * (heading, list, quote, table, image, html, footnote definition), when it is
 * shorter than MIN_CHARS, when it holds no sentence terminator, or when it
 * already points at something.
 */
export function claimCandidates(doc: string): ClaimSpan[] {
  const fmLines = countLines(doc.slice(0, frontmatterLength(doc)));
  const lines = doc.split("\n");
  const out: ClaimSpan[] = [];
  let fenced = false;
  let i = fmLines;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      i++;
      continue;
    }
    if (fenced || line.trim() === "") {
      i++;
      continue;
    }
    let end = i;
    while (
      end + 1 < lines.length &&
      lines[end + 1].trim() !== "" &&
      !/^\s*(```|~~~)/.test(lines[end + 1])
    )
      end++;
    const block = lines.slice(i, end + 1);
    const text = block.join("\n");
    if (
      !block.some((l) => STRUCTURAL.test(l)) &&
      text.trim().length >= MIN_CHARS &&
      TERMINATOR.test(text) &&
      !CITED.test(text)
    ) {
      out.push({ from: i + 1, to: end + 1, text: text.trim() });
    }
    i = end + 1;
  }
  return out;
}

function countLines(s: string): number {
  return s === "" ? 0 : (s.match(/\n/g) ?? []).length;
}

export interface ClaimMarkerOptions {
  claims: readonly ClaimSpan[];
  /** Hover text for the dot. */
  label: string;
  onSelect: (claim: ClaimSpan, x: number, y: number) => void;
}

class ClaimMarker extends GutterMarker {
  constructor(private readonly text: string) {
    super();
  }
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "claim-dot";
    el.title = this.text;
    return el;
  }
}

/** Right-margin dots. No claims → no extension, so the margin costs nothing. */
export function claimMarkers(opts: ClaimMarkerOptions): Extension {
  if (opts.claims.length === 0) return [];
  // Only the paragraph's FIRST line carries the dot: one claim, one mark.
  const at = (line: number): ClaimSpan | undefined =>
    opts.claims.find((c) => c.from === line);
  return gutter({
    class: "cm-claim-gutter",
    side: "after",
    lineMarker: (view, block) => {
      const claim = at(view.state.doc.lineAt(block.from).number);
      return claim ? new ClaimMarker(opts.label) : null;
    },
    lineMarkerChange: (update) => update.docChanged,
    initialSpacer: null,
    domEventHandlers: {
      mousedown: (view, block, event) => {
        const claim = at(view.state.doc.lineAt(block.from).number);
        if (!claim) return false;
        const e = event as MouseEvent;
        opts.onSelect(claim, e.clientX, e.clientY);
        return true;
      },
    },
  });
}
