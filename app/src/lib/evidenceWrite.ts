import { sha256 } from "./tidyRun";

export interface EvidenceWriteIO {
  readFile(path: string): Promise<{ raw: string }>;
  writeFileIfUnchanged(path: string, content: string, expectedSha256: string | null): Promise<unknown>;
}

/** Recognize missing-file errors, never permission, provider, or lookup errors. */
function isAbsent(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
  const message = String(error).replace(/^Error:\s*/, "");
  return /\bENOENT\b|no such file or directory|\(os error 2\)/i.test(message) || /^no such file:/i.test(message);
}

/** Rebuild an append from current bytes after a cooperating writer conflict.
 * External processes and device sync do not share the native process lock. */
export async function writeEvidenceNote<T>(
  io: EvidenceWriteIO,
  path: string,
  transform: (current: string | null) => { content: string; result: T },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let current: string | null;
    try { current = (await io.readFile(path)).raw; }
    catch (error) {
      if (!isAbsent(error)) throw error;
      current = null;
    }
    const expected = current === null ? null : await sha256(current);
    const next = transform(current);
    try {
      await io.writeFileIfUnchanged(path, next.content, expected);
      return next.result;
    } catch (error) {
      if (attempt >= 2 || !/^write conflict:/i.test(String(error).replace(/^Error:\s*/, ""))) throw error;
    }
  }
}
