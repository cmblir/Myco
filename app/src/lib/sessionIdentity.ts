import { VENDOR_LABEL } from "./displayName";
import { getValue, parseFrontmatter, type Frontmatter } from "./frontmatter";

export interface SessionMetadata {
  source: string;
  conversationId: string;
  key: string;
}

export interface SessionIdentity {
  key: string;
  slug: string;
}

/** Recognize vendor transcripts or explicitly imported MCP session metadata. */
export function sessionMetadata(fm: Frontmatter | null): SessionMetadata | null {
  if (!fm || ["source", "conversation_id", "via"].some(key =>
    fm.entries.filter(entry => entry.key === key).length > 1)) return null;
  const source = getValue(fm, "source");
  const id = getValue(fm, "conversation_id");
  if (typeof source !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(source) ||
      typeof id !== "string" || !id.trim() || [...id].some(char =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  if (!Object.hasOwn(VENDOR_LABEL, source) && getValue(fm, "via") !== "mcp") return null;
  const conversationId = id.trim();
  return { source, conversationId, key: `${source}:${conversationId}` };
}

/** Bind every revision to its original session key, without renaming sources. */
export async function sessionIdentity(text: string): Promise<SessionIdentity | null> {
  const doc = text.replace(/^# [^\n]*\n+(?=---)/, "");
  const metadata = sessionMetadata(parseFrontmatter(doc));
  if (!metadata) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(metadata.key));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { key: metadata.key, slug: `session-${metadata.source}-${hash.slice(0, 16)}` };
}
