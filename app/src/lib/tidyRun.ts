// Running a Tidy plan (lib/tidy.ts) against the vault: scan, apply behind a
// snapshot, undo. Writes go through the existing IPC only (write_file /
// move_path), and only ever to wiki/ — isTidyWritable is checked again here,
// on every path, before anything is touched.

import { sessionIdOf } from "./displayName";
import { getValue, parseFrontmatter } from "./frontmatter";
import { ipc } from "./ipc";
import {
  isTidyWritable,
  stemOf,
  type TidyEdit,
  type TidyFile,
  type TidyInput,
} from "./tidy";

/** The vault as Tidy touches it, by vault-relative path: the existing IPC
 *  (read_file / write_file / move_path) in the app, a Map in the tests. */
export interface TidyFs {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** Into `toDir`, same name; refuses an existing target (move_path). */
  move(from: string, toDir: string): Promise<void>;
  /** `dir` and its parents exist afterwards. */
  mkdirs(dir: string): Promise<void>;
}

export function ipcTidyFs(vault: string): TidyFs {
  const abs = (p: string): string => `${vault}/${p}`;
  return {
    read: async (p) => (await ipc.readFile(abs(p))).raw,
    write: async (p, content) => {
      await ipc.writeFile(abs(p), content);
    },
    move: async (from, toDir) => {
      await ipc.movePath(abs(from), abs(toDir));
    },
    mkdirs: async (dir) => {
      const i = dir.lastIndexOf("/");
      // create_folder makes missing parents itself; "already exists" is the
      // one refusal that means the folder is there.
      await ipc
        .createFolder(abs(dir.slice(0, i)), dir.slice(i + 1))
        .catch((e: unknown) => {
          if (!String(e).includes("already exists")) throw e;
        });
    },
  };
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

/** Tidy's input from the vault's markdown paths: every wiki/ page, and only
 *  the transcripts an opaque page names (a real vault holds thousands). */
export async function scanTidy(
  fs: TidyFs,
  paths: string[],
): Promise<TidyInput> {
  const md = paths.filter((p) => p.toLowerCase().endsWith(".md"));
  const pages = await Promise.all(
    md
      .filter(isTidyWritable)
      .map(async (path) => ({ path, raw: await fs.read(path) })),
  );
  const wanted = new Set<string>();
  for (const p of pages) {
    const title = getValue(parseFrontmatter(p.raw), "title");
    for (const id of [
      sessionIdOf(stemOf(p.path)),
      typeof title === "string" ? sessionIdOf(title) : null,
    ])
      if (id) wanted.add(id);
  }
  const found = await Promise.all(
    md
      .filter(
        (p) =>
          /^(sessions|raw)\//.test(p) &&
          wanted.has(sessionIdOf(stemOf(p)) ?? ""),
      )
      // An unreadable transcript (an iCloud placeholder, say) leaves its page
      // untitled — the planner then lists it as skipped, by name.
      .map((path) =>
        fs.read(path).then(
          (raw) => ({ path, raw }),
          () => null,
        ),
      ),
  );
  return { pages, transcripts: found.filter((f): f is TidyFile => f !== null) };
}

/** `.myco/tidy/<timestamp>.json`: what undo needs to put every file back. */
export interface TidySnapshot {
  at: string;
  files: { path: string; to: string; before: string; sha256: string }[];
  /** When the run was undone. */
  undone?: string;
}

export interface TidyReceipt {
  snapshot: string;
  done: TidyEdit[];
  failed: { path: string; error: string }[];
  /** Pages that no longer read as the scan saw them (an autosave, an agent's
   *  write): left as they are, never overwritten with a stale preview. */
  changed: string[];
}

export interface TidyUndo {
  restored: number;
  /** Files changed (or gone) since the run — left as they are. */
  skipped: string[];
  failed: { path: string; error: string }[];
}

const TIDY_DIR = ".myco/tidy";
/** Points at the latest run's snapshot (list_files does not walk dot dirs). */
const LAST = `${TIDY_DIR}/last.json`;

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Snapshot first, then each file in turn; a file that fails is reported and
 *  the rest carry on, and one changed since the scan is left alone. Refuses
 *  the whole run if any path leaves wiki/. */
export async function applyTidy(
  fs: TidyFs,
  edits: TidyEdit[],
  now = new Date(),
): Promise<TidyReceipt> {
  for (const e of edits) {
    const bad = [e.path, e.to].find((p) => !isTidyWritable(p));
    if (bad !== undefined)
      throw new Error(`refused: Tidy only writes wiki/ pages, not ${bad}`);
  }
  const at = now.toISOString();
  const snapshot = `${TIDY_DIR}/${at.replace(/[:.]/g, "-")}.json`;
  const entries = new Map(
    await Promise.all(
      edits.map(
        async (e) =>
          [
            e.path,
            {
              path: e.path,
              to: e.to,
              before: e.before,
              sha256: await sha256(e.after),
            },
          ] as const,
      ),
    ),
  );
  const save = (files: TidySnapshot["files"]): Promise<void> =>
    fs.write(snapshot, JSON.stringify({ at, files } satisfies TidySnapshot));
  await fs.mkdirs(TIDY_DIR);
  await save([...entries.values()]);
  await fs.write(LAST, JSON.stringify({ snapshot }));

  const done: TidyEdit[] = [];
  const failed: TidyReceipt["failed"] = [];
  const changed: string[] = [];
  for (const e of edits) {
    let written = false;
    try {
      // `after` was computed from the scan's text: writing it over a newer
      // save would lose that save, and undo (which restores `before`) could
      // not bring it back. ponytail: no compare-and-swap IPC, so a write in
      // the few ms between this read and the write below still races.
      if ((await fs.read(e.path).catch(() => null)) !== e.before) {
        changed.push(e.path);
        continue;
      }
      if (e.after !== e.before) {
        await fs.write(e.path, e.after);
        written = true;
      }
      if (e.to !== e.path) {
        await fs.mkdirs(dirOf(e.to));
        await fs.move(e.path, dirOf(e.to));
      }
      done.push(e);
    } catch (err) {
      failed.push({ path: e.path, error: String(err) });
      // Rewritten in place before its move failed: still Tidy's to undo.
      if (written) done.push({ ...e, to: e.path });
    }
  }
  if (failed.length || changed.length) {
    // The snapshot names only what Tidy actually changed, where it now is.
    await save(done.map((e) => ({ ...entries.get(e.path)!, to: e.to }))).catch(
      (err: unknown) => failed.push({ path: snapshot, error: String(err) }),
    );
  }
  return { snapshot, done, failed, changed };
}

/** Put each file back — only where it still hashes to what Tidy wrote. */
export async function undoTidy(
  fs: TidyFs,
  snapshotPath: string,
  now = new Date(),
): Promise<TidyUndo> {
  const snap = JSON.parse(await fs.read(snapshotPath)) as TidySnapshot;
  const out: TidyUndo = { restored: 0, skipped: [], failed: [] };
  for (const f of snap.files) {
    // Gone since the run reads the same as changed: leave it, name it.
    const cur = await fs.read(f.to).catch(() => null);
    const ours =
      cur !== null &&
      isTidyWritable(f.path) &&
      isTidyWritable(f.to) &&
      (await sha256(cur)) === f.sha256;
    if (!ours) {
      out.skipped.push(f.to);
      continue;
    }
    try {
      if (f.to !== f.path) await fs.move(f.to, dirOf(f.path));
      if (cur !== f.before) await fs.write(f.path, f.before);
      out.restored++;
    } catch (err) {
      out.failed.push({ path: f.to, error: String(err) });
    }
  }
  await fs.write(
    snapshotPath,
    JSON.stringify({ ...snap, undone: now.toISOString() }),
  );
  return out;
}

/** The latest run, or null when this vault has none (or its pointer is
 *  unreadable — then there is simply nothing to offer undoing). */
export async function lastTidy(
  fs: TidyFs,
): Promise<{ path: string; snapshot: TidySnapshot } | null> {
  let path: unknown;
  try {
    path = (JSON.parse(await fs.read(LAST)) as { snapshot?: unknown }).snapshot;
  } catch {
    return null;
  }
  if (typeof path !== "string") return null;
  return { path, snapshot: JSON.parse(await fs.read(path)) as TidySnapshot };
}
