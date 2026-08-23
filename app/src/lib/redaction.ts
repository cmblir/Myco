// Q4 item 13 — TS-side promotion guard over the Rust redaction scan
// (`ipc.scanTextSecrets`). Shared by every TS path that writes a source into
// the immutable raw/ tier (fullTierIngest's _inbox/ promotion, autoIngest's
// inbox pass), mirroring Rust's `raw_source_guard` on the MCP entry path:
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
