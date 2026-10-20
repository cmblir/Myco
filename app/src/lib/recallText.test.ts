import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every module `file` reaches through static imports (dynamic `import()`
 *  loads later and is left out), as the bundler would put in its chunk. */
function staticImports(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(
    /^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm,
  )) {
    const spec = m[1];
    if (!spec.startsWith(".")) seen.add(spec);
    else
      for (const ext of [".ts", ".tsx"])
        try {
          readFileSync(join(dirname(file), spec + ext));
          staticImports(join(dirname(file), spec + ext), seen);
          break;
        } catch {
          // not this extension
        }
  }
  return seen;
}

describe("recallText stays out of the editor's chunk", () => {
  it("imports nothing from CodeMirror or Lezer", () => {
    // The Ask page quotes with these helpers; a static CodeMirror import
    // pulled the whole editor (+105 kB gzip) onto Ask.
    const cm = (file: string) =>
      [...staticImports(join(__dirname, file))].filter((m) =>
        /^@(codemirror|lezer)\//.test(m),
      );
    expect(cm("editorRecall.ts").length).toBeGreaterThan(0); // the walk works
    expect(cm("recallText.ts")).toEqual([]);
  });

});
