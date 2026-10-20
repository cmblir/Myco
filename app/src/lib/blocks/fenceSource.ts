// A fenced block's source as its panel (./fencePanel) reads and rewrites it:
// the fence's own first and last lines as written, the body between, every
// line led by the container marks of the first (a quote's `> `, an item's
// indent), as tableModel writes a table's lines. Pure (vitest, node).

/** A line of a nested block past the container marks `lead` stands for,
 *  as markdown-it reads it: up to one `>` (and a space) per quote level,
 *  then up to the item's indent. */
export function stripLead(lead: string): (line: string) => string {
  const quotes = lead.split(">").length - 1;
  const marks = new RegExp(`^(?:[ \\t]*>[ \\t]?){0,${quotes}}`);
  const indent = lead.replace(marks, "").length;
  return (line) => {
    const text = line.replace(marks, "");
    let k = 0;
    while (k < indent && (text[k] === " " || text[k] === "\t")) k++;
    return text.slice(k);
  };
}

/** Each line led by `lead`; a blank one by its marks alone (`>`). */
export const ledLines = (lead: string, lines: readonly string[]): string =>
  lines.map((l) => (l ? lead + l : lead.trimEnd())).join("\n");

/** The body between a closed fence's first and last lines. */
export function fenceBody(source: string, lead: string): string {
  return source.split("\n").slice(1, -1).map(stripLead(lead)).join("\n");
}

/** `source` (a closed fence) with `body` between its first and last lines. */
export function withBody(source: string, lead: string, body: string): string {
  const lines = source.split("\n");
  const inner = body ? ledLines(lead, body.split("\n")) + "\n" : "";
  return `${lines[0]}\n${inner}${lines[lines.length - 1]}`;
}

/** A display formula: `$$`, its TeX, `$$`. A blank line would end the
 *  block early, so none is written. */
export function mathSource(lead: string, tex: string): string {
  const lines = tex.split("\n").filter((l) => l.trim());
  return ledLines(lead, ["$$", ...lines, "$$"]);
}
