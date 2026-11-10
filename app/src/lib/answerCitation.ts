import { matchWikilinkAt, wikilinkBase } from "./wikilinks";

/** Answer links only resolve existing files. Never create a missing source,
 * guess between duplicate basenames, or reinterpret a missing qualified path. */
export function resolveAnswerCitation(target: string, root: string, files: string[]): string | null {
  const base = wikilinkBase(target).normalize("NFC");
  if (!base || base.startsWith("/") || base.includes("\\") || base.split("/").some(p => p === ".." || p === ".")) return null;
  const relative = base.replace(/\.md$/i, "");
  const candidates = files.filter(p => p.startsWith(`${root}/`) && /\.md$/i.test(p));
  const exact = candidates.filter(p => p.slice(root.length + 1).replace(/\.md$/i, "").normalize("NFC") === relative);
  if (exact.length === 1) return exact[0];
  if (base.includes("/")) return null;
  const stems = candidates.filter(p => p.split("/").at(-1)!.replace(/\.md$/i, "").normalize("NFC").toLowerCase() === relative.toLowerCase());
  return stems.length === 1 ? stems[0] : null;
}

export class UnverifiedQueryCitation extends Error {
  constructor() { super("The answer contains a citation outside the retrieved sources or an incomplete citation."); }
}

/** A structured model explicitly declined to answer; not a retrieval failure. */
export class ModelEvidenceAbstention extends Error {
  constructor() { super("The model could not support an answer from the supplied records."); }
}

/** A generated reference must name a source actually supplied in this request. */
export function verifyAnswerCitations(answer: string, sourcePaths: string[], requireCitation = false): void {
  // Selected factual workflows must not silently display an uncited answer.
  if (requireCitation && answer.trim() && !answer.includes("[[")) throw new UnverifiedQueryCitation();
  const allowed = new Set(sourcePaths.map(p => p.replace(/\.md$/i, "").normalize("NFC")));
  let at = answer.indexOf("[[");
  while (at !== -1) {
    const link = matchWikilinkAt(answer, at);
    if (!link || !allowed.has(wikilinkBase(link.target).replace(/\.md$/i, "").normalize("NFC"))) throw new UnverifiedQueryCitation();
    at = answer.indexOf("[[", link.end);
  }
}
