// Build-time replacement for `@codemirror/lang-html` (aliased in vite.config.ts
// and vitest.config.ts — same substitution in tests and in the shipped app).
//
// Why: `@codemirror/lang-markdown` imports lang-html at module scope, for
// HTML-tag completion inside markdown and for nested parsing of HTML blocks.
// lang-html in turn pulls lang-css + lang-javascript, i.e. the @lezer html/css/
// javascript grammars. Measured with esbuild over the shared CodeMirror
// baseline: the markdown language costs 232 kB minified with them and 65 kB
// without — 167 kB for HTML-in-markdown.
//
// What it costs us: HTML blocks inside a note keep their text but get no tag
// structure in the syntax tree, and `<` no longer completes tag names (the
// editor passes `completeHTMLTags: false` so that path is never taken). Fenced
// code blocks are NOT affected — the editor has never passed `codeLanguages`,
// so fences have always rendered as plain mono blocks.

import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import type { CompletionResult } from "@codemirror/autocomplete";

/** Consumes characters and highlights nothing. */
const plain = StreamLanguage.define({
  token: (stream) => {
    stream.next();
    return null;
  },
});

export function html(): LanguageSupport {
  return new LanguageSupport(plain);
}

export const htmlLanguage = plain;

export function htmlCompletionSource(): CompletionResult | null {
  return null;
}
