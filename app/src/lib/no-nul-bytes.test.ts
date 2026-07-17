// A NUL byte in a source file makes grep classify the whole file as binary and
// return nothing — silently. graphData.ts carried one (a template-literal
// separator, `${gk}\0${n}`), and it made that ~900-line file invisible to every
// grep-based audit, which then reported findings as if the file were empty.
//
// This guards the class of bug, not the one instance: no tracked source file
// may contain a NUL. Binary assets are excluded by extension.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname; // app/src/
const BINARY = /\.(png|jpe?g|gif|webp|ico|glb|gltf|mov|mp4|webm|woff2?|ttf|otf|wasm)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name === ".DS_Store") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (!BINARY.test(name)) out.push(p);
  }
  return out;
}

describe("source hygiene", () => {
  it("no source file contains a NUL byte", () => {
    const offenders = sourceFiles(ROOT).filter((p) =>
      readFileSync(p).includes(0),
    );
    expect(offenders).toEqual([]);
  });
});
