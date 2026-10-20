// Code plugins' app side (block editor roadmap, stage 6): one PluginHost
// (lib/pluginSandbox) per enabled plugin, whose Worker is made from a blob
// URL of the bootstrap + main.js on the plugin's first `/` command, and the
// seven calls done for real: on the note the command ran in, on wiki/ pages
// only, through the retrieval Ask uses. Every host goes when the plugins'
// state changes (a grant taken back, trust, `.myco/plugins/` read again),
// so the next run reads main.js again. Failures become notices.

import type { EditorView } from "@codemirror/view";
import { retrieveChunks } from "./chat";
import type { Strings } from "./i18n";
import { ipc } from "./ipc";
import { notice } from "./notice";
import type { PluginManifest } from "./plugins";
import {
  MAX_CALLS,
  MAX_FAILURES,
  PluginHost,
  PluginRunError,
  RUN_TIMEOUT_MS,
  pagePathError,
  resolvedAt,
  wikiRel,
  workerSource,
  type PluginRunErrorCode,
  type Syscalls,
  type WorkerLike,
} from "./pluginSandbox";
import { enabledPlugins, usePluginStore } from "../stores/pluginStore";
import { useVaultStore } from "../stores/vaultStore";

const hosts = new Map<string, PluginHost<PluginRun>>();

usePluginStore.subscribe((s, prev) => {
  if (
    s.entries === prev.entries &&
    s.vault === prev.vault &&
    s.trusted === prev.trusted &&
    s.disabled === prev.disabled &&
    s.granted === prev.granted
  )
    return;
  for (const h of hosts.values()) h.dispose();
  hosts.clear();
});

/** `rel` as read from the vault — only if no link on the way moved the
 *  read somewhere else (into raw/, say). */
async function readAt(root: string, rel: string): Promise<string> {
  const f = await ipc.readFile(`${root}/${rel}`);
  if (!resolvedAt(f.path, root, rel)) throw new Error(`${rel} links elsewhere`);
  return f.raw;
}

function spawnWorker(
  main: string,
  onError: (message: string) => void,
): WorkerLike {
  const url = URL.createObjectURL(
    new Blob([workerSource(main)], { type: "text/javascript" }),
  );
  const worker = new Worker(url, { name: "myco-plugin" });
  worker.onerror = (e) => {
    // The plugin's error, reported as its notice — not the page's.
    e.preventDefault();
    onError(e.message || "main.js failed");
  };
  return {
    postMessage: (m, transfer) => worker.postMessage(m, transfer),
    terminate: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}

/** One run of a command: the note it ran in, and whether the run is
 *  over (done, timed out, stopped) — a write still waiting on the IME
 *  must not land after that. */
interface PluginRun {
  view: EditorView;
  over: boolean;
}

/** Resolves once no IME composition runs in `view`. Korean ends one
 *  composition per syllable and starts the next at once, so it looks
 *  again a tick after each end (as calloutLive's composeEndRefresh does). */
const settled = (view: EditorView): Promise<void> =>
  view.composing
    ? new Promise<void>((r) => {
        const end = () => setTimeout(r);
        view.contentDOM.addEventListener("compositionend", end, { once: true });
      }).then(() => settled(view))
    : Promise.resolve();

/** The calls, done for the plugin called `name` in the vault at `root`. */
export function syscalls(name: string, root: string): Syscalls<PluginRun> {
  const open = (view: EditorView): EditorView => {
    if (!view.dom.isConnected) throw new Error("the note was closed");
    return view;
  };
  /** `edit` on the run's note once the IME is done with it: a change
   *  dispatched mid-composition leaves a stray half-syllable behind. */
  const write = async (run: PluginRun, edit: (v: EditorView) => void) => {
    await settled(open(run.view));
    if (run.over) throw new Error("the command has ended");
    edit(open(run.view));
  };
  return {
    "editor.insertAtCursor": (run, text) =>
      write(run, (v) => {
        const at = v.state.selection.main.head;
        // As the note will hold it: CodeMirror turns a \r\n into one break,
        // and the caret is counted in those units.
        const ins = v.state.toText(text);
        v.dispatch({
          changes: { from: at, insert: ins },
          selection: { anchor: at + ins.length },
          scrollIntoView: true,
          userEvent: "input.plugin",
        });
      }),
    "editor.replaceSelection": (run, text) =>
      write(run, (v) =>
        v.dispatch(v.state.replaceSelection(text), {
          scrollIntoView: true,
          userEvent: "input.plugin",
        }),
      ),
    "editor.selection": (run) => {
      const { state } = open(run.view);
      const r = state.selection.main;
      return {
        text: state.sliceDoc(r.from, r.to),
        line: state.doc.lineAt(r.head).text,
      };
    },
    "vault.readPage": (_view, path) => readAt(root, path),
    recall: async (_view, query, k) =>
      (
        await retrieveChunks(query, k, undefined, undefined, "pages")
      ).hits.flatMap((h) =>
        pagePathError(h.page) === null
          ? [{ page: h.page, text: h.text, similarity: h.similarity }]
          : [],
      ),
    search: async (_view, query) =>
      (await ipc.searchVault(query, 20, "wiki")).flatMap((h) => {
        const path = wikiRel(h.path, root);
        return path ? [{ path, line: h.line, snippet: h.snippet }] : [];
      }),
    "ui.notify": (_view, text) => {
      notice.info(name, { sub: text.slice(0, 300) });
    },
  };
}

const TITLE: Record<PluginRunErrorCode, keyof Strings> = {
  timeout: "pl_run_timeout",
  failed: "pl_run_failed",
  stopped: "pl_run_stopped",
  busy: "pl_run_busy",
  calls: "pl_run_calls",
};

/** Run plugin `p`'s main.js `command` on the note in `view`; what goes
 *  wrong is a notice, never a throw into the editor. */
export async function runPluginCommand(
  p: PluginManifest,
  command: string,
  view: EditorView,
  t: Strings,
): Promise<void> {
  const title = (key: keyof Strings): string =>
    t[key]
      .replace("{name}", p.name)
      .replace("{seconds}", String(RUN_TIMEOUT_MS / 1000))
      .replace(
        "{count}",
        String(key === "pl_run_calls" ? MAX_CALLS : MAX_FAILURES),
      );
  const root = useVaultStore.getState().currentVault?.path;
  // The plugin as the gate sees it now: its grant may have been taken
  // back, or its manifest read again, since the menu was built.
  const current = (): PluginManifest | undefined =>
    useVaultStore.getState().currentVault?.path === root
      ? enabledPlugins(usePluginStore.getState()).find((x) => x.id === p.id)
      : undefined;
  if (!root || !current()) return;
  let host = hosts.get(p.id);
  if (!host) {
    let main: string;
    try {
      main = await readAt(root, `.myco/plugins/${p.id}/main.js`);
    } catch (err) {
      notice.warn(title("pl_run_no_main"), { sub: String(err) });
      return;
    }
    // Asked again after the read, and the host made from what the manifest
    // asks now. (A host that exists is current: any change disposes it.)
    const m = current();
    if (!m) return;
    host =
      hosts.get(p.id) ??
      new PluginHost<PluginRun>({
        spawn: (onError) => spawnWorker(main, onError),
        permissions: m.permissions,
        syscalls: syscalls(m.name, root),
      });
    hosts.set(p.id, host);
  }
  const run: PluginRun = { view, over: false };
  try {
    await host.run(command, run);
  } catch (err) {
    // Disposed meanwhile (its grant or trust changed): nothing to say.
    if (hosts.get(p.id) !== host) return;
    if (!(err instanceof PluginRunError)) {
      notice.warn(title("pl_run_failed"), { sub: String(err) });
      return;
    }
    const why =
      err.code === "failed"
        ? err.message
        : err.code === "stopped"
          ? undefined
          : title(TITLE[err.code]);
    if (host.stopped) notice.warn(title("pl_run_stopped"), { sub: why });
    else if (err.code === "failed")
      notice.warn(title("pl_run_failed"), { sub: why });
    else notice.warn(title(TITLE[err.code]));
  } finally {
    run.over = true;
  }
}
