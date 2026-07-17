import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Three lists that have to agree and had no mechanism keeping them together:
//
//   lib.rs generate_handler![…]   what the backend actually registers
//   ipc.ts invoke<T>("…")        what the frontend calls
//   devMock.ts case "…":         what the mock answers
//
// Drift here is quiet in both directions. A command the frontend calls but the
// backend does not register works in dev (the mock answers) and fails only in
// the packaged app. A command the mock does not answer used to resolve
// `undefined` — which is how ingest, the app's headline feature, sat broken
// under ?mock=1: it called claude_run_stream, got undefined, and died on
// `res.status` with a TypeError that read like an app bug, in the mock every
// E2E suite runs against.
//
// Parsed with regexes rather than a TS/Rust AST on purpose: the point is a cheap
// check that runs on every `npm test`, and these three call shapes are stable.

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

/** Commands the Rust side registers. */
function registered(): Set<string> {
  const src = read("../../src-tauri/src/lib.rs");
  const block = /generate_handler!\[(.*?)\]/s.exec(src);
  if (!block) throw new Error("could not find generate_handler! in lib.rs");
  return new Set([...block[1].matchAll(/commands::(\w+)/g)].map((m) => m[1]));
}

/** Commands the frontend invokes. */
function invoked(): Set<string> {
  const src = read("./ipc.ts");
  const names = [...src.matchAll(/invoke(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map((m) => m[1]);
  // Tauri's own plugin channels are not our commands.
  return new Set(names.filter((n) => !n.startsWith("plugin:")));
}

/** Commands the dev mock answers.
 *
 * Scoped to mockInvoke's body: devMock has a second switch for the agent TOOL
 * names (read_page, create_page…), which are not Tauri commands and would
 * otherwise read as stale mock cases. */
function mocked(): Set<string> {
  const src = read("./devMock.ts");
  const start = src.indexOf("function mockInvoke");
  if (start < 0) throw new Error("could not find mockInvoke in devMock.ts");
  const body = src.slice(start);
  const names = [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
  return new Set(names.filter((n) => !n.startsWith("plugin:")));
}

describe("devMock / ipc / lib.rs command parity", () => {
  it("every command the frontend invokes is registered in lib.rs", () => {
    const missing = [...invoked()].filter((c) => !registered().has(c)).sort();
    // A typo or a removed command: works against the mock, fails in the dmg.
    expect(missing).toEqual([]);
  });

  it("every registered command is reachable from ipc.ts", () => {
    const unused = [...registered()].filter((c) => !invoked().has(c)).sort();
    // Dead backend surface — either wire it up or delete it. If something is
    // deliberately called from outside ipc.ts, list it here with a reason.
    expect(unused).toEqual([]);
  });

  it("every command the frontend invokes is answered by the mock", () => {
    const unmocked = [...invoked()].filter((c) => !mocked().has(c)).sort();
    // devMock's default rejects, so an unmocked command is now a loud failure
    // in dev rather than an `undefined` that surfaces as a TypeError somewhere
    // unrelated. This keeps that from being discovered at runtime.
    expect(unmocked).toEqual([]);
  });

  it("the mock answers nothing the frontend cannot ask for", () => {
    const stale = [...mocked()].filter((c) => !invoked().has(c)).sort();
    // A mock case for a command nobody calls is a leftover; it also hides the
    // fact that the real command is gone.
    expect(stale).toEqual([]);
  });
});
