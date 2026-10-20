// Q4 item 13 — TS-side promotion guard over the Rust redaction scan
// (`ipc.scanTextSecrets`). Shared by every TS path that writes a source into
// the immutable raw/ tier (the link import, pasted text and YouTube
// transcripts via startIngest, autoIngest's inbox pass), mirroring Rust's `raw_source_guard` on the MCP entry path:
// secrets always block; PII blocks only when the quarantine toggle is on
// (warn-only otherwise).
import type { SecretScanReport } from "./ipc";

/** True when `scan` allows writing the source to raw/. A false verdict means
 *  the caller must leave the source where it is (raw/ is immutable — a
 *  flagged write could never be unwound). */
export function shouldPromote(scan: SecretScanReport, piiQuarantine: boolean): boolean {
  if (scan.secrets.length > 0) return false;
  if (piiQuarantine && scan.pii.length > 0) return false;
  return true;
}

export type SourceCheck =
  | { ok: true; piiWarn: boolean }
  | { ok: false; code: "secret" | "pii" | "scan" };

/** The one check every TS path runs on text before it can reach raw/: scan,
 *  then the promotion rule above. A failed scan refuses (fail closed) — the
 *  text would otherwise reach raw/ unscanned. Codes name the kind of finding,
 *  never the matched text. */
export async function checkSourceText(
  text: string,
  scan: (text: string) => Promise<SecretScanReport>,
  piiQuarantine: boolean,
): Promise<SourceCheck> {
  let report: SecretScanReport;
  try {
    report = await scan(text);
  } catch {
    return { ok: false, code: "scan" };
  }
  if (report.secrets.length > 0) return { ok: false, code: "secret" };
  if (!shouldPromote(report, piiQuarantine)) return { ok: false, code: "pii" };
  return { ok: true, piiWarn: report.pii.length > 0 };
}
