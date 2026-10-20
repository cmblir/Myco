// S38 — a pasted article link imports like a pasted source. Rust
// (`fetch_web_page`) does the SSRF-guarded fetch and returns markdown; this
// decides when to offer it, runs the same secret/PII rule every raw/ writer
// uses (redaction.ts) before the text reaches the ingest box, and maps the
// stable refusal codes to i18n keys. Pure, deps injected, so it tests in node.
import type { Strings } from "./i18n";
import type { SecretScanReport, WebPage } from "./ipc";
import { checkSourceText } from "./redaction";

/** One pasted http(s) link — not a body that merely mentions one, and not
 *  YouTube (that has its own transcript button). */
export function looksLikeWebLink(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t) || t.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return !(h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com"));
}

const CODE_KEYS = {
  bad_url: "ing_web_err_bad_url",
  scheme: "ing_web_err_scheme",
  credentials: "ing_web_err_credentials",
  blocked: "ing_web_err_blocked",
  resolve: "ing_web_err_resolve",
  redirect: "ing_web_err_redirect",
  redirects: "ing_web_err_redirects",
  not_html: "ing_web_err_not_html",
  too_large: "ing_web_err_too_large",
  timeout: "ing_web_err_timeout",
  network: "ing_web_err_network",
  empty: "ing_web_err_empty",
  secret: "ing_web_err_secret",
  pii: "ing_web_err_pii",
  scan: "ing_web_err_scan",
} as const satisfies Record<string, keyof Strings>;

export type WebLinkErrorKey =
  | (typeof CODE_KEYS)[keyof typeof CODE_KEYS]
  | "ing_web_err_status"
  | "ing_web_err_other";

/** i18n key for a refusal code; `status:<n>` carries `n` for the `{n}` slot. */
export function webLinkErrorKey(code: string): { key: WebLinkErrorKey; n?: string } {
  const status = /^status:(\d+)$/.exec(code);
  if (status) return { key: "ing_web_err_status", n: status[1] };
  return { key: CODE_KEYS[code as keyof typeof CODE_KEYS] ?? "ing_web_err_other" };
}

/** Plain message for a refusal code. */
export function webLinkError(code: string, t: Strings): string {
  const { key, n } = webLinkErrorKey(code);
  return t[key].replace("{n}", n ?? "");
}

export type WebLinkResult =
  | { ok: true; title: string; body: string; piiWarn: boolean }
  | { ok: false; code: string };

/** Fetch `url` and vet the text with `checkSourceText`: a secret always
 *  refuses, PII refuses only under the quarantine toggle (else warns). A
 *  failed scan refuses too — the text would otherwise reach raw/ unscanned. */
export async function importWebLink(
  url: string,
  deps: {
    fetchPage: (url: string) => Promise<WebPage>;
    scan: (text: string) => Promise<SecretScanReport>;
    piiQuarantine: boolean;
  },
): Promise<WebLinkResult> {
  let page: WebPage;
  try {
    page = await deps.fetchPage(url);
  } catch (err) {
    return { ok: false, code: String(err) };
  }
  const body = `Source: ${page.url}\n\n${page.markdown}`;
  // The title is fetched text too: it fills the Title field and becomes the
  // `# <title>` heading of the raw/ file, so it gets the same rule.
  const check = await checkSourceText(`${page.title}\n\n${body}`, deps.scan, deps.piiQuarantine);
  if (!check.ok) return check;
  return { ok: true, title: page.title, body, piiWarn: check.piiWarn };
}

/** Title after an import: fill an empty one, replace one an earlier import
 *  filled in (`lastAuto`), keep one the user typed. */
export function nextAutoTitle(prev: string, lastAuto: string, incoming: string): string {
  return !prev || prev === lastAuto ? incoming : prev;
}

export interface WebLinkMsg {
  text: string;
  isError: boolean;
}

/** The import message after the box is edited: a refusal was about the old
 *  link, so it goes; the PII notice is about the imported text, so it stays. */
export function msgAfterEdit(msg: WebLinkMsg | null): WebLinkMsg | null {
  return msg?.isError ? null : msg;
}
