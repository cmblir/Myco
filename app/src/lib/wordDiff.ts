// Pure LCS diff core shared by the run log (PageHistory) and the agent
// write-confirm dialog. Line-level LCS first; adjacent del/add line pairs get
// intra-line word segments. No dependencies, node-testable.

export interface DiffSeg {
  kind: "same" | "add" | "del";
  text: string;
}
export type DiffLine =
  | { kind: "ctx"; text: string }
  | { kind: "add"; segs: DiffSeg[] }
  | { kind: "del"; segs: DiffSeg[] };

const GAP = "⋯";
const LINE_CAP = 4000;

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/** Classic O(n·m) LCS over token arrays. Ties prefer del so a replacement emits its del run first. */
function lcsOps(a: string[], b: string[]): DiffSeg[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  // LCS length fits u16: line inputs are capped at LINE_CAP, word inputs are single lines.
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops: DiffSeg[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ kind: "del", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] });
  while (j < m) ops.push({ kind: "add", text: b[j++] });
  return ops;
}

function mergeSegs(segs: DiffSeg[]): DiffSeg[] {
  const out: DiffSeg[] = [];
  for (const s of segs) {
    if (s.text === "") continue;
    const last = out[out.length - 1];
    if (last && last.kind === s.kind) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/**
 * Word-level diff of two single lines. Tokens are whitespace-split and atomic
 * (no intra-token splitting, so a CJK particle change marks only its token);
 * whitespace tokens are glue and never marked. Adjacent same-kind segments merge.
 */
export function diffWords(before: string, after: string): DiffSeg[] {
  const tok = (s: string) => s.split(/(\s+)/).filter((t) => t !== "");
  const ops = lcsOps(tok(before), tok(after));
  const softened = ops.map((s): DiffSeg =>
    s.kind !== "same" && /^\s+$/.test(s.text) ? { kind: "same", text: s.text } : s,
  );
  return mergeSegs(softened);
}

function collapse(lines: DiffLine[], context: number): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "ctx") {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].kind === "ctx") j++;
    const run = lines.slice(i, j);
    const keepHead = i > 0 ? context : 0; // trailing context of the previous hunk
    const keepTail = j < lines.length ? context : 0; // leading context of the next hunk
    if (run.length > keepHead + keepTail) {
      out.push(...run.slice(0, keepHead));
      out.push({ kind: "ctx", text: GAP });
      out.push(...run.slice(run.length - keepTail));
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

/**
 * Line-level LCS diff; adjacent del/add line pairs get intra-line word segments
 * via diffWords. `context` = unchanged lines kept around each change hunk
 * (default 2); longer gaps collapse to a { kind: "ctx", text: "⋯" } marker.
 * Cap: beyond 4000 lines per side the O(n·m) LCS is skipped — whole-file
 * del+add without the word pass.
 */
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > LINE_CAP || b.length > LINE_CAP) {
    const out: DiffLine[] = [];
    for (const t of a) out.push({ kind: "del", segs: [{ kind: "del", text: t }] });
    for (const t of b) out.push({ kind: "add", segs: [{ kind: "add", text: t }] });
    return out;
  }
  const ops = lcsOps(a, b);
  const lines: DiffLine[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === "same") {
      lines.push({ kind: "ctx", text: ops[i].text });
      i++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (i < ops.length && ops[i].kind === "del") dels.push(ops[i++].text);
    while (i < ops.length && ops[i].kind === "add") adds.push(ops[i++].text);
    const paired = Math.min(dels.length, adds.length);
    const wordSegs: DiffSeg[][] = [];
    for (let k = 0; k < paired; k++) wordSegs.push(diffWords(dels[k], adds[k]));
    for (let k = 0; k < dels.length; k++) {
      lines.push({
        kind: "del",
        segs:
          k < paired
            ? mergeSegs(wordSegs[k].filter((s) => s.kind !== "add"))
            : [{ kind: "del", text: dels[k] }],
      });
    }
    for (let k = 0; k < adds.length; k++) {
      lines.push({
        kind: "add",
        segs:
          k < paired
            ? mergeSegs(wordSegs[k].filter((s) => s.kind !== "del"))
            : [{ kind: "add", text: adds[k] }],
      });
    }
  }
  return collapse(lines, context);
}
