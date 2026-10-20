// Sandboxed code plugins (block editor roadmap, stage 6): a plugin's
// `main.js` runs in a dedicated Web Worker made from a blob URL — its own
// global, no DOM, no `window.__TAURI_INTERNALS__` (Tauri injects that into
// the page, never into a worker), and no way to call IPC over the custom
// protocol either: that needs the runtime invoke key, which lives in a
// closure of the page's init script. The CSP (tauri.conf.json) already has
// `worker-src 'self' blob:`; a blob worker inherits the page's CSP, so
// main.js gets no eval and no network beyond `connect-src`: the app's own
// files and a local Ollama (localhost:11434).
//
// All the worker can do to the app is post calls over one MessagePort, and
// PluginHost answers only the SYSCALLS its manifest was granted, with
// arguments checked here, and only while one of its commands runs. A run
// has a timeout (the worker is terminated: nothing else stops a loop), a
// call budget, and after MAX_FAILURES failures in a row the plugin is
// stopped. Pure: no app imports, so vitest runs the real bootstrap in a
// node worker_threads Worker (pluginSandbox.test); lib/pluginRuntime spawns
// the browser Worker and implements the calls.

import { SYSCALLS, type Syscall } from "./plugins";

/** How long one command may run, calls it waits on included. */
export const RUN_TIMEOUT_MS = 5000;
/** Failed runs in a row (thrown, timed out, crashed) that stop a plugin. */
export const MAX_FAILURES = 3;
/** Calls one run may make. A loop posting calls without waiting would
 *  flood the main thread with messages; past this the worker is gone. */
export const MAX_CALLS = 100;
/** The longest text a call takes (an insert, a query, a notice). */
const MAX_TEXT = 200_000;

// The worker's side, as plain ES2017 source — never built from a function's
// toString(), which the minifier may rewrite to use helpers from module
// scope that a worker does not have. main.js follows it in the same script,
// so its top level registers commands before any message arrives.
export const BOOTSTRAP = `(function () {
  "use strict";
  var handlers = new Map();
  var pending = new Map();
  var port = null;
  var seq = 0;
  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      if (!port) return reject(new Error("myco is not connected yet"));
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      port.postMessage({ t: "call", id: id, method: method, args: args });
    });
  }
  function message(e) {
    return String((e && e.message) || e);
  }
  self.myco = Object.freeze({
    command: function (name, fn) {
      if (typeof name === "string" && typeof fn === "function") handlers.set(name, fn);
    },
    call: call,
    editor: Object.freeze({
      insertAtCursor: function (text) { return call("editor.insertAtCursor", text); },
      replaceSelection: function (text) { return call("editor.replaceSelection", text); },
      selection: function () { return call("editor.selection"); },
    }),
    vault: Object.freeze({
      readPage: function (path) { return call("vault.readPage", path); },
    }),
    recall: function (query, k) { return call("recall", query, k); },
    search: function (query) { return call("search", query); },
    ui: Object.freeze({
      notify: function (text) { return call("ui.notify", text); },
    }),
  });
  self.onmessage = function (e) {
    var d = e.data;
    if (port || !d || d.type !== "myco:init" || !d.port) return;
    port = d.port;
    port.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.t === "reply") {
        var p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error === undefined) p.resolve(m.value);
        else p.reject(new Error(m.error));
      } else if (m.t === "run") {
        var fn = handlers.get(m.command);
        Promise.resolve()
          .then(function () {
            if (!fn) throw new Error('main.js has no command "' + m.command + '"');
            return fn();
          })
          .then(
            function () { port.postMessage({ t: "done", id: m.id }); },
            function (err) { port.postMessage({ t: "done", id: m.id, error: message(err) }); }
          );
      }
    };
  };
})();
`;

/** The whole worker script: the bootstrap, then the plugin's main.js. */
export const workerSource = (main: string): string =>
  `${BOOTSTRAP}\n;\n${main}\n`;

/** The one part of a Worker the host uses. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

/** What each allowed call does, given the run's context (the editor view)
 *  and arguments already checked. */
export interface Syscalls<C> {
  "editor.insertAtCursor": (ctx: C, text: string) => unknown;
  "editor.replaceSelection": (ctx: C, text: string) => unknown;
  "editor.selection": (ctx: C) => unknown;
  "vault.readPage": (ctx: C, path: string) => unknown;
  recall: (ctx: C, query: string, k: number) => unknown;
  search: (ctx: C, query: string) => unknown;
  "ui.notify": (ctx: C, text: string) => unknown;
}

export type PluginRunErrorCode =
  | "timeout"
  | "failed"
  | "stopped"
  | "busy"
  | "calls";

export class PluginRunError extends Error {
  constructor(
    readonly code: PluginRunErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "PluginRunError";
  }
}

/** Pure — vault.readPage's guard: why `path` is not a page under `wiki/`
 *  (vault-relative, `/`-separated, a `.md` file), or null when it is. No
 *  raw/, sessions/, .myco/ or any other folder, no absolute path, no `..`,
 *  `.` or empty segment, no hidden file. A link inside wiki/ is caught
 *  after the read (lib/pluginRuntime resolvedAt). */
export function pagePathError(path: unknown): string | null {
  if (typeof path !== "string") return "expects a path";
  if (path.length > 1024 || /[\\\0]/.test(path)) return "not a vault path";
  const parts = path.split("/");
  if (parts[0] !== "wiki" || parts.length < 2) return "not under wiki/";
  if (parts.some((s) => s === "" || s.startsWith(".")))
    return "not a plain path";
  if (!/\.md$/i.test(path)) return "not a .md page";
  return null;
}

/** `/` separators and NFC, so paths compare as the user sees them. */
const norm = (p: string): string => p.replace(/\\/g, "/").normalize("NFC");
const rootOf = (root: string): string => norm(root).replace(/\/+$/, "");

/** Pure: read_file answered for `resolved` (canonical: links followed) —
 *  is that `<root>/<rel>` itself? A link on the way (wiki/ or a page that
 *  points into raw/) resolves elsewhere and is refused. `root` is the
 *  canonical vault root open_vault returned. */
export function resolvedAt(
  resolved: string,
  root: string,
  rel: string,
): boolean {
  return norm(resolved) === `${rootOf(root)}/${norm(rel)}`;
}

/** Pure: a search hit's absolute `path` as a plugin may see it — a page
 *  under wiki/, vault-relative — or null for anything else. */
export function wikiRel(path: string, root: string): string | null {
  const base = `${rootOf(root)}/`;
  const p = norm(path);
  if (!p.startsWith(base)) return null;
  const rel = p.slice(base.length);
  return pagePathError(rel) === null ? rel : null;
}

const text = (v: unknown): string | null =>
  typeof v !== "string"
    ? "expects text"
    : v.length > MAX_TEXT
      ? "text is too long"
      : null;

/** Why `args` are not what `method` takes, or null; recall's `k` is
 *  filled in (5) and kept to 1..20. */
function argsError(method: Syscall, args: unknown[]): string | null {
  switch (method) {
    case "editor.selection":
      return null;
    case "vault.readPage":
      return pagePathError(args[0]);
    case "recall": {
      if (args[1] === undefined) args[1] = 5;
      if (typeof args[1] !== "number" || !Number.isFinite(args[1]))
        return "k must be a number";
      args[1] = Math.min(20, Math.max(1, Math.round(args[1])));
      return text(args[0]);
    }
    default:
      return text(args[0]);
  }
}

const isSyscall = (v: unknown): v is Syscall =>
  (SYSCALLS as readonly unknown[]).includes(v);

interface Run<C> {
  id: number;
  ctx: C;
  calls: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (e: PluginRunError) => void;
}

export interface PluginHostOptions<C> {
  /** A new worker running workerSource(main.js); `onError` gets its
   *  uncaught errors (a syntax error in main.js among them). */
  spawn: (onError: (message: string) => void) => WorkerLike;
  /** The calls the user granted (a manifest's `permissions`). */
  permissions: readonly Syscall[];
  syscalls: Syscalls<C>;
  timeoutMs?: number;
  maxFailures?: number;
  maxCalls?: number;
}

/** One plugin's worker, spawned on its first run and kept between runs.
 *  One run at a time; its calls act on that run's context. */
export class PluginHost<C> {
  /** Failed MAX_FAILURES times in a row (or disposed): runs are refused. */
  stopped = false;
  private worker: WorkerLike | null = null;
  private port: MessagePort | null = null;
  private active: Run<C> | null = null;
  private failures = 0;
  private seq = 0;
  private readonly timeoutMs: number;
  private readonly maxFailures: number;
  private readonly maxCalls: number;

  constructor(private readonly opts: PluginHostOptions<C>) {
    this.timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
    this.maxFailures = opts.maxFailures ?? MAX_FAILURES;
    this.maxCalls = opts.maxCalls ?? MAX_CALLS;
  }

  /** Run main.js's `command` with `ctx` as the editor its calls act on. */
  run(command: string, ctx: C): Promise<void> {
    if (this.stopped) return Promise.reject(new PluginRunError("stopped"));
    if (this.active) return Promise.reject(new PluginRunError("busy"));
    const port = this.connect();
    return new Promise<void>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(
        () => this.finish(new PluginRunError("timeout"), true),
        this.timeoutMs,
      );
      this.active = { id, ctx, calls: 0, timer, resolve, reject };
      port.postMessage({ t: "run", id, command });
    });
  }

  /** Stop for good: the worker is terminated, a run under way fails. */
  dispose(): void {
    this.stopped = true;
    const a = this.active;
    this.active = null;
    if (a) {
      clearTimeout(a.timer);
      a.reject(new PluginRunError("stopped"));
    }
    this.kill();
  }

  private connect(): MessagePort {
    if (this.port) return this.port;
    const channel = new MessageChannel();
    const port = channel.port1;
    const worker = this.opts.spawn((message) => {
      if (worker !== this.worker) return;
      if (this.active) this.finish(new PluginRunError("failed", message), true);
      else this.kill();
    });
    port.onmessage = (e: MessageEvent) => this.receive(port, e.data);
    // The port is the only thing the worker is ever given.
    worker.postMessage({ type: "myco:init", port: channel.port2 }, [
      channel.port2,
    ]);
    this.worker = worker;
    this.port = port;
    return port;
  }

  private kill(): void {
    this.worker?.terminate();
    this.port?.close();
    this.worker = null;
    this.port = null;
  }

  /** End the run under way; `kill` = its worker cannot be trusted to
   *  answer again (timed out, crashed, flooding). */
  private finish(error: PluginRunError | null, kill = false): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    clearTimeout(a.timer);
    if (!error) {
      this.failures = 0;
      a.resolve();
      return;
    }
    this.failures++;
    if (this.failures >= this.maxFailures) this.stopped = true;
    if (kill || this.stopped) this.kill();
    a.reject(error);
  }

  private receive(port: MessagePort, m: unknown): void {
    if (port !== this.port || typeof m !== "object" || m === null) return;
    const msg = m as { t?: unknown; id?: unknown; error?: unknown };
    if (msg.t === "done") {
      if (this.active && msg.id === this.active.id)
        this.finish(
          msg.error === undefined
            ? null
            : new PluginRunError("failed", String(msg.error).slice(0, 300)),
        );
    } else if (msg.t === "call") {
      this.serve(port, m as { id?: unknown; method?: unknown; args?: unknown });
    }
  }

  private serve(
    port: MessagePort,
    m: { id?: unknown; method?: unknown; args?: unknown },
  ): void {
    const reply = (r: { value?: unknown; error?: string }): void => {
      if (port !== this.port) return;
      try {
        port.postMessage({ t: "reply", id: m.id, ...r });
      } catch {
        // A value that cannot be cloned: the plugin hears why, not nothing.
        port.postMessage({ t: "reply", id: m.id, error: "no answer to send" });
      }
    };
    const a = this.active;
    if (!a) return reply({ error: "no command is running" });
    if (++a.calls > this.maxCalls) {
      this.finish(new PluginRunError("calls"), true);
      return;
    }
    const { method } = m;
    if (!isSyscall(method))
      return reply({
        error: `"${String(method).slice(0, 80)}" is not a myco call`,
      });
    if (!this.opts.permissions.includes(method))
      return reply({ error: `"${method}" was not granted` });
    const args = Array.isArray(m.args) ? m.args.slice(0, 2) : [];
    const bad = argsError(method, args);
    if (bad) return reply({ error: `${method}: ${bad}` });
    const fn = this.opts.syscalls[method] as (
      ctx: C,
      ...a: unknown[]
    ) => unknown;
    Promise.resolve()
      .then(() => fn(a.ctx, ...args))
      .then(
        (value) => reply({ value }),
        (err: unknown) =>
          reply({
            error: String((err as Error)?.message ?? err).slice(0, 300),
          }),
      );
  }
}
