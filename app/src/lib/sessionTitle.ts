// A readable title for an imported session transcript — the one helper both
// extractive ingest (new summaries) and Tidy (existing ones) name a session
// by, so the two can never disagree. The transcript's own first heading is the
// first user prompt, verbatim (importers/mod.rs `to_inbox_doc`).

import { sessionIdOf, VENDOR_LABEL } from "./displayName";
import { getValue, parseFrontmatter } from "./frontmatter";
import { stripFrontmatter } from "./markdown";
import { sessionMetadata, type SessionMetadata } from "./sessionIdentity";
import { today } from "./taskLine";

const MAX_TITLE = 60;

function isFallbackTitle(title: string, metadata: SessionMetadata): boolean {
  const candidate = title.replace(/^Source: /, "");
  const { source, conversationId } = metadata;
  const sanitized = conversationId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return candidate === conversationId || candidate === sanitized ||
    candidate === `${source}-${conversationId}` || candidate === `source-${source}-${conversationId}` ||
    sessionIdOf(candidate) !== null ||
    // MCP filenames append a fingerprint when an ID needs sanitizing or truncation.
    ((sanitized !== conversationId || sanitized.length > 180) &&
      candidate.startsWith(`${sanitized.slice(0, 120)}-`) &&
      /^[a-f0-9]{16}$/.test(candidate.slice(sanitized.slice(0, 120).length + 1)));
}

function recordedDate(created: unknown): string | null {
  if (typeof created === "number") {
    const parsed = new Date(created * 1000);
    return Number.isFinite(parsed.getTime()) ? today(parsed) : null;
  }
  if (typeof created !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(created)) return null;
  const parsed = new Date(`${created}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === created ? created : null;
}

/** A readable session name, source and recorded date; opaque names use H1.
 * Accepts legacy vendor transcripts and arbitrary sources imported via MCP. */
export function sessionTitle(text: string): string | null {
  const doc = text.replace(/^# [^\n]*\n+(?=---)/, "");
  const fm = parseFrontmatter(doc);
  const metadata = sessionMetadata(fm);
  const source = getValue(fm, "source");
  const agent = typeof source === "string" && Object.hasOwn(VENDOR_LABEL, source)
    ? VENDOR_LABEL[source] : metadata?.source;
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(stripFrontmatter(doc))?.[1];
  const supplied = metadata ? getValue(fm, "title") : undefined;
  const name = typeof supplied === "string" && supplied.trim() && !/[\r\n]/.test(supplied) &&
    metadata && !isFallbackTitle(supplied.trim(), metadata) ? supplied.trim() : heading;
  if (!agent || !name) return null;
  const chars = [...name];
  const shown =
    chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join("").trimEnd()}…` : name;
  const created = getValue(fm, "created");
  const recordedDay = typeof created === "number" || metadata ? recordedDate(created) : null;
  const date = recordedDay ? ` · ${recordedDay}` : "";
  return `${shown} · ${agent}${date}`;
}
