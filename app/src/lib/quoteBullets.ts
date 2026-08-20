// Bullet-text quality for the two extractive digest paths (ROADMAP P1:
// "extractive digest quality"). Everything here is a pure function over text
// and vectors — sessionDigest.ts and weeklyRollup.ts keep their marker,
// fingerprint and section-label contracts untouched; this file only changes
// what the bullets SAY.
//
// Embeddings only, by design: the extractive path exists because
// builtin-local has no generative model, so a rewrite is off the table. What
// is left is cutting the quotes at the right place, not quoting the same
// thing twice, naming the source once, and dropping the "네, 알겠습니다"
// preamble that carries no decision.

/** One candidate quote and the source it is attributed to (a session stem for
 * the daily digest, a day for the weekly rollup). */
export interface QuoteUnit {
  text: string;
  label: string;
}

// Sentence terminators. The full-width forms are here because a Korean or
// Japanese log ends a sentence in 。？！ as readily as in ./?/!.
const ASCII_END = ".!?…";
const CJK_END = "。！？";
// CJK/Hangul text has no inter-sentence space, so a terminator followed
// straight by one of these scripts is still a sentence end.
const CJK_SCRIPT = /[\p{sc=Hangul}\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u;

/** Cut `text` to at most `limit` chars at a sentence boundary when one exists
 * in the back half of the budget, else at the hard cap. Marks the cut either
 * way — a quote that ends early is still a quote of something longer — but a
 * boundary cut gets a spaced ellipsis so the sentence's own punctuation reads
 * normally. */
export function trimToSentence(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  // Half the budget: a boundary earlier than that throws away more of the
  // quote than a ragged cut costs. Picked, not measured.
  const floor = Math.floor(limit / 2);
  for (let i = window.length - 1; i >= floor; i--) {
    const ch = window[i];
    const ascii = ASCII_END.includes(ch);
    if (!ascii && !CJK_END.includes(ch)) continue;
    const next = window[i + 1];
    // "v2.11.1" and "e.g" must not read as boundaries: an ASCII terminator
    // ends a sentence only at the window edge, before whitespace, or before
    // CJK text (which never puts a space there).
    if (ascii && next !== undefined && !/\s/.test(next) && !CJK_SCRIPT.test(next)) continue;
    return `${window.slice(0, i + 1)} …`;
  }
  return `${window.trimEnd()}…`;
}

// Leading acknowledgments. A turn that opens with one of these says nothing a
// digest bullet needs; the content starts after it. A punctuation delimiter is
// required, which is what keeps "Right-click the node" and "예상 결과" intact —
// note ASCII "-" is deliberately NOT a delimiter for that reason.
const FILLER_HEAD =
  /^(?:sure|ok|okay|alright|right|great|perfect|nice|thanks|thank you|got it|understood|of course|certainly|absolutely|indeed|hmm|well|yes|yeah|yep|no problem|네|넵|예|옙|응|오케이|알겠습니다|알겠어요|알겠어|좋아요|좋습니다|좋아|감사합니다|고맙습니다|확인했습니다|맞아요|그래요)\s*[,.!?~—–:]+\s*/iu;

/** Strip up to two leading acknowledgments ("Okay. Got it. <content>" is two,
 * not one). Returns "" for a turn that was nothing but filler — callers apply
 * their minimum-length filter after this, which is how such a turn stops being
 * a candidate at all. */
export function stripFiller(text: string): string {
  let out = text;
  for (let pass = 0; pass < 2; pass++) {
    const next = out.replace(FILLER_HEAD, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Cosine above which a candidate counts as restating something already
// picked. MEASURED against the real bundled embedder, not guessed — see
// local_llm.rs's `near_dup_threshold_separates_restatements_from_distinct_turns`
// (ignored; loads the 417 MB bge-m3 GGUF), which holds the fixtures and
// re-checks these numbers:
//
//   near-verbatim edit of one turn ......... 0.9929
//   same decision, reworded (en) ........... 0.8529
//   same decision, reworded (ko) ........... 0.8626
//   ko turn vs its en restatement .......... 0.7118
//   different decision, SAME task .......... 0.6794   <- hardest true negative
//   unrelated turns from the same day ...... 0.4820 / 0.4530
//
// 0.80 is the gap's midpoint biased upward: a false drop loses a real decision
// while a false keep only repeats one. A first guess of 0.92 (from the usual
// "paraphrases live in the 0.9s" folklore) would never have fired on anything
// but a near-verbatim copy. Cross-language restatements are NOT caught — at
// 0.71 they sit 0.03 above the hardest true negative, too close to separate.
export const NEAR_DUP_COSINE = 0.8;

/** Filter a ranked index list down to quotes that are not near-duplicates of
 * an earlier-ranked pick. Keeps rank order; O(k²) cosines over a list already
 * capped at a few dozen. */
export function dropNearDuplicates(
  ranked: number[],
  vectors: number[][],
  threshold = NEAR_DUP_COSINE,
): number[] {
  const kept: number[] = [];
  for (const i of ranked) {
    if (kept.every((j) => cosine(vectors[i], vectors[j]) <= threshold)) kept.push(i);
  }
  return kept;
}

/** Render selected units as `**<label>**` once, followed by that label's
 * quotes. Labels appear in the order their best-ranked quote ranked, so the
 * strongest conversation still leads — grouping only moves that
 * conversation's other quotes up to join it. Deterministic: Map iteration is
 * insertion order. */
export function renderQuoteBullets(
  units: QuoteUnit[],
  selected: number[],
  bulletChars: number,
): string {
  const groups = new Map<string, string[]>();
  for (const i of selected) {
    const unit = units[i];
    const quote = trimToSentence(unit.text, bulletChars);
    const existing = groups.get(unit.label);
    if (existing) existing.push(quote);
    else groups.set(unit.label, [quote]);
  }
  return [...groups]
    .map(([label, quotes]) => [`**${label}**`, ...quotes.map((q) => `- "${q}"`)].join("\n"))
    .join("\n\n");
}
