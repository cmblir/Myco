import { describe, expect, it, vi } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { syscalls } from "./pluginRuntime";
import { BUILTIN_EMBED_MODEL } from "./providers";

vi.mock("./notice", () => ({ notice: { info: vi.fn(), warn: vi.fn() } }));

// The backend as Rust answers. search_vault walks every .md in path order
// and stops at `limit` — daily/, raw/ and sessions/ all sort before wiki/
// — unless kept to one `folder`. semantic_search's "wiki" scope keeps the
// digests, "pages" only wiki/ notes and maps.
const FILES = [
  ...Array.from({ length: 25 }, (_, i) => `daily/2026-09-${i + 10}.md`),
  "raw/paper.md",
  "sessions/s1.md",
  "wiki/attention.md",
  "wiki/transformer.md",
];
const CHUNKS = [
  ...FILES.slice(0, 6).map((page) => ({ page, text: "d", similarity: 0.9 })),
  { page: "wiki/attention.md", text: "w", similarity: 0.8 },
];
vi.mock("./ipc", () => ({
  ipc: {
    searchVault: async (_q: string, limit: number, folder?: string) =>
      FILES.filter((f) => !folder || f.startsWith(`${folder}/`))
        .slice(0, limit)
        .map((f) => ({
          path: `/v/${f}`,
          name: f,
          line: 1,
          snippet: "attention",
        })),
    embeddingsStatus: async () => ({
      indexed_pages: 10,
      model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
    }),
    semanticSearch: async (_q: string, k: number, ...rest: unknown[]) => ({
      floor: 0,
      below_floor: [],
      hits: CHUNKS.filter((c) =>
        rest[3] === "pages"
          ? c.page.startsWith("wiki/")
          : !/^(sessions|raw)\//.test(c.page),
      )
        .slice(0, k)
        .map((c) => ({ ...c, stem: c.page, section: 0, score: 1 })),
    }),
  },
}));

/** An editor as the calls see it: a real state, no DOM. */
function fakeView(doc: string, caret = doc.length) {
  const view = {
    state: EditorState.create({ doc, selection: { anchor: caret } }),
    dom: { isConnected: true },
    contentDOM: new EventTarget(),
    composing: false,
    dispatch(...specs: TransactionSpec[]) {
      view.state = view.state.update(...specs).state;
    },
  };
  return view;
}

const ROOT = "/v";
const sc = syscalls("P", ROOT);
type FakeView = ReturnType<typeof fakeView>;
/** One run's context, as runPluginCommand hands it to the calls. */
const runOf = (view: FakeView) => ({
  view: view as unknown as EditorView,
  over: false,
});
const insert = (view: FakeView, text: string, run = runOf(view)) =>
  sc["editor.insertAtCursor"](run, text);
const tick = () => new Promise((r) => setTimeout(r));
/** The IME ends a composition; `next` = Korean starts the next syllable
 *  at once, so the editor is composing again by the following tick. */
const compositionEnd = (view: FakeView, next = false) => {
  view.composing = next;
  view.contentDOM.dispatchEvent(new Event("compositionend"));
};

describe("editor.insertAtCursor", () => {
  it("puts the caret after the text as the note holds it (CRLF read from a page)", async () => {
    const v = fakeView("# t\n\n");
    await insert(v, "a\r\nb");
    expect(v.state.doc.toString()).toBe("# t\n\na\nb");
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
    // Mid-note: the next insert goes where the first one ended.
    const m = fakeView("AAA\n\nBBB", 4);
    await insert(m, "x\r\ny\r\n");
    await insert(m, "[END]");
    expect(m.state.doc.toString()).toBe("AAA\nx\ny\n[END]\nBBB");
  });
});

describe("an editor write during an IME composition", () => {
  it("waits until the composition is over, then lands once", async () => {
    const v = fakeView("# t\n\n");
    v.composing = true;
    let done = false;
    const p = Promise.resolve(insert(v, "INSERTED")).then(() => (done = true));
    await tick();
    expect(v.state.doc.toString()).toBe("# t\n\n");
    // A syllable ends and the next one starts: still the IME's.
    compositionEnd(v, true);
    await tick();
    await tick();
    expect(v.state.doc.toString()).toBe("# t\n\n");
    expect(done).toBe(false);
    compositionEnd(v);
    await p;
    expect(v.state.doc.toString()).toBe("# t\n\nINSERTED");
  });

  it("replaceSelection waits too", async () => {
    const v = fakeView("abc");
    v.state = EditorState.create({
      doc: "abc",
      selection: { anchor: 0, head: 3 },
    });
    v.composing = true;
    const p = sc["editor.replaceSelection"](runOf(v), "X");
    await tick();
    expect(v.state.doc.toString()).toBe("abc");
    compositionEnd(v);
    await p;
    expect(v.state.doc.toString()).toBe("X");
  });

  it("is refused when its run ended (timed out, stopped) while it waited", async () => {
    const v = fakeView("# t\n\n");
    v.composing = true;
    const run = runOf(v);
    const p = Promise.resolve(insert(v, "LATE", run));
    await tick();
    run.over = true;
    compositionEnd(v);
    await expect(p).rejects.toThrow(/ended/);
    expect(v.state.doc.toString()).toBe("# t\n\n");
  });

  it("goes in at once when no composition runs", async () => {
    const v = fakeView("a");
    void insert(v, "b");
    // No timer between the call and the edit: a plugin that does not
    // await its insert still sees it land before its command's end.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(v.state.doc.toString()).toBe("ab");
  });
});

describe("search and recall", () => {
  it("search finds the matching wiki/ pages, however many other notes match", async () => {
    expect(await sc.search(runOf(fakeView("")), "attention")).toEqual([
      { path: "wiki/attention.md", line: 1, snippet: "attention" },
      { path: "wiki/transformer.md", line: 1, snippet: "attention" },
    ]);
  });

  it("recall's k counts wiki/ pages, not the digests ranked above them", async () => {
    expect(await sc.recall(runOf(fakeView("")), "attention", 5)).toEqual([
      { page: "wiki/attention.md", text: "w", similarity: 0.8 },
    ]);
  });
});
