// Note templates: plain .md files in <vault>/templates/ with {{date}},
// {{time}} and {{title}} placeholders. Rust keeps the folder out of the
// graph/Views (index.rs is_staging_dir) and seeds no stub inside it
// (vault.rs NON_WIKI_DIRS); the sidebar still lists it.

import { ipc } from "./ipc";
import type { FileNode } from "./ipc";
import type { Strings } from "./i18n";
import { sanitizeNoteName } from "./newNote";
import { today } from "./taskLine";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

export interface TemplateVars {
  date: string;
  time: string;
  title: string;
}

/** Substitute the three known placeholders; an unknown `{{x}}` stays as-is. */
export function applyTemplate(raw: string, vars: TemplateVars): string {
  return raw.replace(
    /\{\{\s*(date|time|title)\s*\}\}/g,
    (_, key: keyof TemplateVars) => vars[key],
  );
}

/** Local wall-clock `HH:MM`. */
export function localTime(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** `.md` files directly under the top-level `templates/` folder. */
export function templateFiles(tree: FileNode[]): FileNode[] {
  for (const node of tree) {
    if (node.kind === "directory" && node.name === "templates") {
      return node.children.filter(
        (c) => c.kind === "file" && /\.md$/i.test(c.name),
      );
    }
  }
  return [];
}

/** A raw/ context dir falls back to wiki/ — templates never write into raw/. */
export function templateTargetDir(
  root: string,
  dir: string | undefined,
): string | undefined {
  const rawDir = `${root}/raw`;
  if (dir === undefined || dir === rawDir || dir.startsWith(`${rawDir}/`)) {
    return undefined;
  }
  return dir;
}

// Placeholders are quoted: a bare `{{title}}` is a YAML flow mapping.
function starter(type: string, tags: string, body: string): string {
  return (
    `---\ntitle: "{{title}}"\ntype: ${type}\ntags: ${tags}\ncreated: "{{date}}"\n` +
    `confidence: medium\nstatus: active\n---\n\n# {{title}}\n\n${body}`
  );
}

export function starterTemplates(
  t: Strings,
): { name: string; content: string }[] {
  return [
    {
      name: `${t.tpl_starter_note ?? "note"}.md`,
      content: starter("concept", "[]", t.tpl_starter_note_body ?? ""),
    },
    {
      name: `${t.tpl_starter_meeting ?? "meeting"}.md`,
      content: starter(
        "source-summary",
        "[meeting]",
        t.tpl_starter_meeting_body ?? "",
      ),
    },
  ];
}

/** Create `templates/` with the two localized starters and refresh the tree. */
export async function createStarterTemplates(t: Strings): Promise<void> {
  const store = useVaultStore.getState();
  const root = store.currentVault?.path;
  if (!root) return;
  await ipc.createFolder(root, "templates").catch(() => undefined);
  for (const s of starterTemplates(t)) {
    await ipc.writeFile(`${root}/templates/${s.name}`, s.content);
  }
  await store.refreshTree();
}

/**
 * Create `<dir>/<name>.md` from a template and route into it. An existing stem
 * opens as-is (never overwritten, same rule as ⌘N). Returns the routed path or
 * null (invalid name / no vault); a failed read or write throws to the caller.
 */
export async function createNoteFromTemplate(
  templatePath: string,
  rawName: string,
  dir?: string,
): Promise<string | null> {
  const name = sanitizeNoteName(rawName);
  if (!name) return null;
  const store = useVaultStore.getState();
  const { setRoute } = useUIStore.getState();
  const existing = store.resolveWikilink(name);
  if (existing) {
    setRoute(`page:${existing}`);
    return existing;
  }
  const root = store.currentVault?.path;
  if (!root) return null;
  const tpl = await ipc.readFile(templatePath);
  const path = await store.openWikilink(name, templateTargetDir(root, dir));
  if (!path) return null;
  // ipc, not saveFile: saveFile swallows failures into vaultStore.error.
  await ipc.writeFile(
    path,
    applyTemplate(tpl.raw, { date: today(), time: localTime(), title: name }),
  );
  void store.refreshLinkGraph();
  setRoute(`page:${path}`);
  return path;
}
