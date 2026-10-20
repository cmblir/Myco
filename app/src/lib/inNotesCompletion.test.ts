import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { CompletionContext } from "@codemirror/autocomplete";
import { noteContentCompletion } from "./inNotesCompletion";
import type { RetrievedChunks } from "./chat";
import { STRINGS } from "./i18n";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A completion query as CodeMirror runs it: `aborted` flips when typing
 *  aborts it; `opts` records how the source asked to be aborted. */
function query(doc: string) {
  const c = {
    state: EditorState.create({ doc }),
    pos: doc.length,
    explicit: false,
    aborted: false,
    opts: [] as unknown[],
    addEventListener(_type: string, _fn: () => void, opts?: unknown) {
      c.opts.push(opts);
    },
  };
  return c;
}
const run = (
  source: ReturnType<typeof noteContentCompletion>,
  c: ReturnType<typeof query>,
) => source(c as unknown as CompletionContext);

const found: RetrievedChunks = {
  hits: [
    {
      page: "wiki/attention.md",
      stem: "attention",
      section: 0,
      text: "## Heads\n\nMany heads attend.",
      score: 0.03,
      similarity: 0.61,
    },
  ],
  nearMisses: [],
  floor: 0.42,
  indexedPages: 10,
  stale: false,
  retrievalFailed: false,
};

describe("noteContentCompletion — `[[` In notes", () => {
  it("searches once the typing pauses, not for each earlier prefix", async () => {
    const calls: string[] = [];
    const source = noteContentCompletion(
      STRINGS.en,
      (q) => {
        calls.push(q);
        return Promise.resolve(found);
      },
      20,
    );
    const a = query("[[atte");
    const first = run(source, a);
    // A keystroke before the pause aborts the query (CodeMirror keeps a
    // running query alive across typing unless asked).
    expect(a.opts).toContainEqual({ onDocChange: true });
    a.aborted = true;
    const b = query("[[atten");
    const second = run(source, b);
    expect(await first).toBeNull();
    const r = await second;
    expect(calls).toEqual(["atten"]);
    expect(r?.options.map((o) => o.displayLabel)).toEqual(["attention#Heads"]);
  });

  it("runs one search at a time; a query aborted while waiting never runs", async () => {
    const calls: string[] = [];
    const pending: (() => void)[] = [];
    const source = noteContentCompletion(
      STRINGS.en,
      (q) => {
        calls.push(q);
        return new Promise((r) => pending.push(() => r(found)));
      },
      5,
    );
    const a = query("[[attention");
    const ra = run(source, a);
    await sleep(20);
    expect(calls).toEqual(["attention"]);
    // A newer query's pause ends while the first search is still running.
    a.aborted = true;
    const b = query("[[attention he");
    const rb = run(source, b);
    await sleep(20);
    expect(calls).toEqual(["attention"]);
    b.aborted = true; // typed on while waiting
    const c = query("[[attention heads");
    const rc = run(source, c);
    await sleep(20);
    pending.shift()?.();
    await sleep(20);
    expect(calls).toEqual(["attention", "attention heads"]);
    pending.shift()?.();
    expect(await ra).toBeNull();
    expect(await rb).toBeNull();
    expect((await rc)?.options).toHaveLength(1);
  });

  it("waits for three characters and ignores `[[note#`", async () => {
    const calls: string[] = [];
    const source = noteContentCompletion(
      STRINGS.en,
      (q) => {
        calls.push(q);
        return Promise.resolve(found);
      },
      1,
    );
    expect(await run(source, query("[[at"))).toBeNull();
    expect(await run(source, query("[[note#hea"))).toBeNull();
    expect(calls).toEqual([]);
  });
});
