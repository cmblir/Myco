import { afterAll, describe, expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
import {
  BOOTSTRAP,
  PluginHost,
  PluginRunError,
  pagePathError,
  resolvedAt,
  wikiRel,
  workerSource,
  type Syscalls,
  type WorkerLike,
} from "./pluginSandbox";
import { SYSCALLS, type Syscall } from "./plugins";

// Real threads boot slowly on a loaded machine: no assertion here is about
// wall-clock time, the host's own timeout is generous except where the
// timeout is the subject, and a test may take long.
vi.setConfig({ testTimeout: 30_000 });

// The real bootstrap + main.js, in a real thread. A node Worker has no
// `self` and takes messages on parentPort: this shim is all that differs
// from the browser's dedicated Worker (lib/pluginRuntime spawns that one).
const SHIM = `
const { parentPort } = require("node:worker_threads");
globalThis.self = globalThis;
parentPort.on("message", (data) => {
  if (typeof self.onmessage === "function") self.onmessage({ data });
});
`;

const live: Worker[] = [];
afterAll(async () => {
  await Promise.all(live.splice(0).map((w) => w.terminate()));
});

/** What the host is handed: every worker it spawns, and what it sent. */
function nodeWorkers(main: string) {
  const spawned: { worker: Worker; exited: Promise<number> }[] = [];
  const sent: unknown[] = [];
  const spawn = (onError: (message: string) => void): WorkerLike => {
    const worker = new Worker(SHIM + workerSource(main), { eval: true });
    live.push(worker);
    worker.on("error", (e) => onError(e.message));
    const exited = new Promise<number>((r) => worker.once("exit", r));
    spawned.push({ worker, exited });
    return {
      postMessage: (m, transfer) => {
        sent.push(m);
        worker.postMessage(m, transfer as never);
      },
      terminate: () => void worker.terminate(),
    };
  };
  return { spawn, spawned, sent };
}

interface Ctx {
  doc: string;
  sel: string;
}

/** Syscalls that record what they were asked; `ctx` is the "editor". */
function fakeSyscalls() {
  const log: [Syscall, ...unknown[]][] = [];
  const syscalls: Syscalls<Ctx> = {
    "editor.insertAtCursor": (ctx, text) => {
      log.push(["editor.insertAtCursor", text]);
      ctx.doc += text;
    },
    "editor.replaceSelection": (ctx, text) => {
      log.push(["editor.replaceSelection", text]);
      ctx.sel = text;
    },
    "editor.selection": (ctx) => {
      log.push(["editor.selection"]);
      return { text: ctx.sel, line: ctx.doc };
    },
    "vault.readPage": (_ctx, path) => {
      log.push(["vault.readPage", path]);
      return `# ${path}`;
    },
    recall: (_ctx, query, k) => {
      log.push(["recall", query, k]);
      return [];
    },
    search: (_ctx, query) => {
      log.push(["search", query]);
      return [];
    },
    "ui.notify": (_ctx, text) => {
      log.push(["ui.notify", text]);
    },
  };
  return { log, syscalls };
}

function host(
  main: string,
  opts: Partial<ConstructorParameters<typeof PluginHost<Ctx>>[0]> = {},
) {
  const w = nodeWorkers(main);
  const f = fakeSyscalls();
  const h = new PluginHost<Ctx>({
    spawn: w.spawn,
    permissions: SYSCALLS,
    syscalls: f.syscalls,
    timeoutMs: 15_000,
    ...opts,
  });
  return { h, ...w, ...f };
}

const ctx = (doc = "", sel = ""): Ctx => ({ doc, sel });

async function failure(p: Promise<unknown>): Promise<PluginRunError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PluginRunError);
    return e as PluginRunError;
  }
  throw new Error("the run did not fail");
}

// One plugin, one worker, for every test that needs no fresh worker of its
// own: each thread is a V8 isolate to boot, and a file booting many of them
// slows the timing-bound tests of other files running beside it.
const KIT_MAIN = `
  const tell = (late) => require("node:worker_threads").parentPort.postMessage({ late });
  let last = "";
  myco.command("count", async () => {
    const { text, line } = await myco.editor.selection();
    const n = (text || line).split(/\\s+/).filter(Boolean).length;
    await myco.editor.insertAtCursor(" (" + n + " words)");
  });
  myco.command("ok", () => {});
  myco.command("slow", () => new Promise((r) => setTimeout(r, 200)));
  myco.command("write", () => myco.call("vault.writeFile", "wiki/x.md", "pwned"));
  myco.command("ipc", () => myco.call("__TAURI_INTERNALS__.invoke", "delete_path"));
  myco.command("proto", () => myco.call("constructor"));
  myco.command("num", () => myco.editor.insertAtCursor(42));
  myco.command("huge", () => myco.ui.notify("x".repeat(300000)));
  myco.command("k", () => myco.recall("q", "all"));
  myco.command("read", async () => {
    last = "";
    for (const p of ["raw/paper.md", "../secret.md", "/etc/passwd", ".myco/plugins/x/main.js", "sessions/s.md", "wiki/../raw/a.md"]) {
      try { await myco.vault.readPage(p); last += "read " + p + ";"; }
      catch (e) { last += "refused;"; }
    }
    last += await myco.vault.readPage("wiki/노트.md");
  });
  myco.command("report", () => myco.editor.insertAtCursor(last));
  myco.command("later", () => {
    setTimeout(() => myco.ui.notify("late").then(() => tell("served"), (e) => tell(e.message)), 0);
  });
  myco.command("r", async () => { await myco.recall("a"); await myco.recall("b", 500); await myco.recall("c", 0); });
  myco.command("probe", () => myco.editor.insertAtCursor(JSON.stringify({
    tauri: typeof __TAURI_INTERNALS__,
    tauriGlobal: typeof __TAURI__,
    ipc: typeof ipc,
    invoke: typeof invoke,
    window: typeof window,
  })));
`;
let kitHost: ReturnType<typeof host> | null = null;
/** The shared plugin's host, its call log cleared. Refused calls fail runs
 *  here on purpose, so it is never stopped for failing. */
function kit(): ReturnType<typeof host> {
  kitHost ??= host(KIT_MAIN, { maxFailures: Number.POSITIVE_INFINITY });
  kitHost.log.length = 0;
  return kitHost;
}
afterAll(() => kitHost?.h.dispose());

describe("PluginHost: running a command in the worker", () => {
  it("runs the handler main.js registered, serving the calls it makes", async () => {
    const { h, log } = kit();
    const c = ctx("one two three");
    await h.run("count", c);
    expect(c.doc).toBe("one two three (3 words)");
    expect(log.map((l) => l[0])).toEqual([
      "editor.selection",
      "editor.insertAtCursor",
    ]);
  });

  it("keeps one worker across runs", async () => {
    const { h, spawned } = kit();
    await h.run("ok", ctx());
    await h.run("ok", ctx());
    expect(spawned).toHaveLength(1);
  });

  it("a name main.js did not register fails the run", async () => {
    const { h } = kit();
    const e = await failure(h.run("nope", ctx()));
    expect(e.code).toBe("failed");
    expect(e.message).toContain("nope");
  });

  it("a syntax error in main.js fails the run at once, not at the timeout", async () => {
    // Waiting for this timeout would outlast the test's own.
    const { h } = host(`this is not javascript (`, { timeoutMs: 120_000 });
    const e = await failure(h.run("x", ctx()));
    expect(e.code).toBe("failed");
    expect(e.message).toMatch(/SyntaxError|Unexpected/);
    h.dispose();
  });

  it("a second run while one is under way is refused, not queued", async () => {
    const { h } = kit();
    const slow = h.run("slow", ctx());
    expect((await failure(h.run("ok", ctx()))).code).toBe("busy");
    await slow;
  });
});

describe("PluginHost: the syscall allowlist", () => {
  it("refuses a method that is not a myco call; nothing of the app runs", async () => {
    const { h, log } = kit();
    for (const cmd of ["write", "ipc", "proto"]) {
      const e = await failure(h.run(cmd, ctx()));
      expect(e.code, cmd).toBe("failed");
      expect(e.message, cmd).toMatch(/is not a myco call/);
    }
    expect(log).toEqual([]);
  });

  it("refuses an allowlisted call the plugin was not granted", async () => {
    const { h, log } = host(
      `myco.command("r", () => myco.recall("attention", 3));`,
      { permissions: ["editor.selection"] },
    );
    const e = await failure(h.run("r", ctx()));
    expect(e.message).toMatch(/"recall" was not granted/);
    expect(log).toEqual([]);
    h.dispose();
  });

  it("refuses arguments of the wrong kind", async () => {
    const { h, log } = kit();
    for (const cmd of ["num", "huge", "k"])
      expect((await failure(h.run(cmd, ctx()))).code, cmd).toBe("failed");
    expect(log).toEqual([]);
  });

  it("vault.readPage reads wiki/ pages only", async () => {
    const { h, log } = kit();
    await h.run("read", ctx());
    const c = ctx();
    await h.run("report", c);
    expect(c.doc).toBe("refused;".repeat(6) + "# wiki/노트.md");
    expect(log.filter((l) => l[0] === "vault.readPage")).toEqual([
      ["vault.readPage", "wiki/노트.md"],
    ]);
  });

  it("refuses a call made while none of its commands runs", async () => {
    // The call goes out after "done" (a timer, the next task); how it was
    // answered comes back on the thread's own channel, a test-only side
    // door (node's parentPort), so no second run can race it.
    const { h, log, spawned } = kit();
    const run = h.run("later", ctx());
    const told = new Promise((r) =>
      spawned[spawned.length - 1].worker.once("message", r),
    );
    await run;
    expect(await told).toEqual({ late: "no command is running" });
    expect(log).toEqual([]);
  });

  it("recall's count defaults and is kept to 1..20", async () => {
    const { h, log } = kit();
    await h.run("r", ctx());
    expect(log).toEqual([
      ["recall", "a", 5],
      ["recall", "b", 20],
      ["recall", "c", 1],
    ]);
  });
});

describe("PluginHost: timeout and terminate()", () => {
  it("a command that never returns is terminated at the timeout; the next run gets a new worker", async () => {
    // Blocked for good without burning a core (Atomics.wait), so this test
    // does not slow the timing-bound tests running beside it; a real busy
    // loop is the browser check's (stage6/03-run.mjs). 3 s: long enough
    // for the second worker to boot on a loaded machine.
    const { h, spawned } = host(
      `myco.command("spin", () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
       myco.command("ok", () => {});`,
      { timeoutMs: 3000 },
    );
    const e = await failure(h.run("spin", ctx()));
    expect(e.code).toBe("timeout");
    // The blocked thread is really gone, not just ignored.
    await spawned[0].exited;
    await h.run("ok", ctx());
    expect(spawned).toHaveLength(2);
    expect(h.stopped).toBe(false);
    h.dispose();
  });

  it("failures in a row stop the plugin; a success in between starts the count again", async () => {
    const { h, spawned } = host(`
      myco.command("bad", () => { throw new Error("broken"); });
      myco.command("ok", () => {});
    `);
    for (const cmd of ["bad", "bad", "ok", "bad", "bad"]) {
      if (cmd === "ok") await h.run(cmd, ctx());
      else expect((await failure(h.run(cmd, ctx()))).message).toBe("broken");
    }
    expect(h.stopped).toBe(false);
    await failure(h.run("bad", ctx()));
    expect(h.stopped).toBe(true);
    await spawned[0].exited;
    expect((await failure(h.run("ok", ctx()))).code).toBe("stopped");
    expect(spawned).toHaveLength(1);
  });

  it("a run that floods the host with calls is terminated", async () => {
    const { h, log, spawned } = host(`
      myco.command("flood", () => {
        for (let i = 0; i < 1000; i++) myco.ui.notify("x").catch(() => {});
        return new Promise(() => {});
      });
    `);
    const e = await failure(h.run("flood", ctx()));
    expect(e.code).toBe("calls");
    expect(log.length).toBeLessThanOrEqual(100);
    await spawned[0].exited;
    h.dispose();
  });

  it("dispose() stops a run under way and the worker with it", async () => {
    const { h, spawned } = host(
      `myco.command("wait", () => new Promise(() => {}));`,
    );
    const run = h.run("wait", ctx());
    await new Promise((r) => setTimeout(r, 100));
    h.dispose();
    expect((await failure(run)).code).toBe("stopped");
    await spawned[0].exited;
  });
});

describe("the worker cannot reach Tauri IPC", () => {
  it("its global has no __TAURI_INTERNALS__, no ipc, no window", async () => {
    const { h } = kit();
    const c = ctx();
    await h.run("probe", c);
    expect(JSON.parse(c.doc)).toEqual({
      tauri: "undefined",
      tauriGlobal: "undefined",
      ipc: "undefined",
      invoke: "undefined",
      window: "undefined",
    });
  });

  it("the bootstrap names nothing of Tauri, and the host sends it only data and one port", async () => {
    expect(BOOTSTRAP).not.toMatch(
      /__TAURI|invoke|\bipc\b|import\(|importScripts|eval|Function\(/,
    );
    const { h, sent } = kit();
    await h.run("ok", ctx());
    // One message on the worker itself, for its whole life: the port the
    // RPC runs over.
    expect(sent).toHaveLength(1);
    const [init] = sent as { type: string; port: unknown }[];
    expect(Object.keys(init).sort()).toEqual(["port", "type"]);
    expect(init.type).toBe("myco:init");
  });
});

describe("pagePathError (vault.readPage's guard)", () => {
  it.each([
    "wiki/note.md",
    "wiki/a/b/c.md",
    "wiki/노트 제목.md",
    "wiki/raw/under-wiki.MD",
  ])("accepts %j", (p) => {
    expect(pagePathError(p)).toBeNull();
  });

  it.each([
    "raw/paper.md",
    "sessions/2026-09-01.md",
    ".myco/plugins/x/main.js",
    "_inbox/clip.md",
    "/etc/passwd.md",
    "/Users/me/vault/wiki/a.md",
    "wiki/../raw/a.md",
    "wiki/a/../../raw/a.md",
    "wiki/./a.md",
    "wiki//a.md",
    "wiki/.hidden.md",
    "wiki\\..\\raw\\a.md",
    "C:\\vault\\wiki\\a.md",
    "~/wiki/a.md",
    "Wiki/a.md",
    "wiki/a.txt",
    "wiki/",
    "wiki",
    "",
    "wiki/a\0.md",
    `wiki/${"a".repeat(1100)}.md`,
  ])("refuses %j", (p) => {
    expect(pagePathError(p)).not.toBeNull();
  });

  it("refuses what is not text", () => {
    for (const v of [undefined, null, 3, ["wiki/a.md"], { path: "wiki/a.md" }])
      expect(pagePathError(v)).not.toBeNull();
  });
});

describe("resolvedAt (a read landed where it was asked, no link moved it)", () => {
  it("is the file itself under the vault root", () => {
    expect(resolvedAt("/v/wiki/a.md", "/v", "wiki/a.md")).toBe(true);
    expect(resolvedAt("/v/wiki/a.md", "/v/", "wiki/a.md")).toBe(true);
    // Windows separators, and a name stored decomposed (NFD) on disk.
    expect(resolvedAt("C:\\v\\wiki\\a.md", "C:\\v", "wiki/a.md")).toBe(true);
    const nfd = "wiki/노트.md".normalize("NFD");
    expect(resolvedAt(`/v/${nfd}`, "/v", "wiki/노트.md")).toBe(true);
  });

  it("is not a link's target, even one that ends the same way", () => {
    expect(resolvedAt("/v/raw/a.md", "/v", "wiki/a.md")).toBe(false);
    // wiki/ itself a link into raw/: the tail still reads wiki/a.md.
    expect(resolvedAt("/v/raw/x/wiki/a.md", "/v", "wiki/a.md")).toBe(false);
    expect(resolvedAt("/elsewhere/wiki/a.md", "/v", "wiki/a.md")).toBe(false);
    expect(resolvedAt("/v2/wiki/a.md", "/v", "wiki/a.md")).toBe(false);
  });
});

describe("wikiRel (search hits a plugin may see)", () => {
  it("keeps a page under wiki/, as a vault path", () => {
    expect(wikiRel("/v/wiki/a/b.md", "/v")).toBe("wiki/a/b.md");
    expect(wikiRel("C:\\v\\wiki\\a.md", "C:\\v")).toBe("wiki/a.md");
  });

  it("drops raw/, sessions/, anything outside the vault", () => {
    for (const p of [
      "/v/raw/a.md",
      "/v/sessions/s.md",
      "/v/_inbox/c.md",
      "/v2/wiki/a.md",
      "/other/wiki/a.md",
      "wiki/a.md",
    ])
      expect(wikiRel(p, "/v"), p).toBeNull();
  });
});
