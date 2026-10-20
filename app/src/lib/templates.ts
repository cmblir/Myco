// Note templates: plain .md files in <vault>/templates/ with {{date}},
// {{time}} and {{title}} placeholders. Rust keeps the folder out of the
// graph/Views (index.rs is_staging_dir) and seeds no stub inside it
// (vault.rs NON_WIKI_DIRS); the sidebar still lists it. One with `slash:`
// frontmatter is also an editor `/` item (templateSlashItem).

import { ipc } from "./ipc";
import type { FileNode } from "./ipc";
import type { Strings } from "./i18n";
import type { SlashItem } from "./editorCompletions";
import {
  getValue,
  parseFrontmatter,
  patchFrontmatter,
  type Frontmatter,
} from "./frontmatter";
import { stripFrontmatter } from "./markdown";
import { defaultNoteDir, sanitizeNoteName } from "./newNote";
import { normalizeQuery } from "./settingsSearch";
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

/** A frontmatter scalar as trimmed text; "" for none, a list or a flag. */
function fmText(fm: Frontmatter | null, key: string): string {
  const v = getValue(fm, key);
  return typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
}

/** `s` without its trailing blank lines (the spaces ending its last text line
 *  stay: `- ` is an empty bullet). A walk back, not `/(?:\r?\n[ \t]*)+$/`:
 *  that regex retries from every newline of a blank run mid-body, quadratic
 *  in the run, and this runs per template on every `/` keystroke. */
function trimTrailingBlankLines(s: string): string {
  let i = s.length;
  while (i > 0 && " \t\r\n".includes(s[i - 1])) i--;
  const nl = s.indexOf("\n", i);
  if (nl < 0) return s;
  return s.slice(0, s[nl - 1] === "\r" ? nl - 1 : nl);
}

/**
 * A template whose frontmatter has `slash: <keyword>` as a `/` item: its body
 * (frontmatter dropped, placeholders filled) goes in as plain text, a block of
 * its own, the caret where its first `${}` was (every `${}` marker goes; none
 * = after the body). `slash_label` names it in the menu (else the file does,
 * the file name then matching too); `slash_section` groups it (else
 * Templates). Null without `slash:` — the template stays a new-note template
 * only.
 */
export function templateSlashItem(
  fileName: string,
  raw: string,
  vars: TemplateVars,
): SlashItem | null {
  const fm = parseFrontmatter(raw);
  const label = normalizeQuery(fmText(fm, "slash"));
  if (!label) return null;
  const name = fileName.replace(/\.md$/i, "");
  const slashLabel = fmText(fm, "slash_label");
  const section = fmText(fm, "slash_section");
  // Blank lines around the body go: set apart, the block brings its own.
  const body = trimTrailingBlankLines(
    stripFrontmatter(raw).replace(/^(?:[ \t]*\r?\n)+/, ""),
  );
  return {
    label,
    detail: slashLabel || name,
    aliases: slashLabel ? [normalizeQuery(name)] : [],
    icon: "▤",
    section: "templates",
    ...(section ? { sectionName: section } : {}),
    ...fillBody(body, vars),
    apart: true,
  };
}

/** A `/` item's body as plain text: placeholders filled, every `${}`
 *  marker gone, the caret where the first one was (none = at the end). */
export function fillBody(
  body: string,
  vars: TemplateVars,
): { template: string; caret: number } {
  // CodeMirror's text: every `\r\n` (or lone `\r`) is one `\n`, so a CRLF
  // file's caret offset would overshoot the text inserted.
  // Split first: a filled {{title}} holding `${}` stays text.
  const parts = body
    .replace(/\r\n?/g, "\n")
    .split("${}").map((part) => applyTemplate(part, vars));
  const template = parts.join("");
  return {
    template,
    caret: parts.length > 1 ? parts[0].length : template.length,
  };
}

/** The placeholders' values for the note titled `title`, now. */
export function templateVars(
  title: string,
  now: Date = new Date(),
): TemplateVars {
  return { date: today(now), time: localTime(now), title };
}

/** The last read of `templates/`, and the vault it was read in. */
let slashSources: {
  vault: string | undefined;
  files: { name: string; raw: string }[];
} = { vault: undefined, files: [] };

/**
 * Re-read `templates/*.md` for the `/` menu. Editor calls it for each `/`
 * query, so a template added, edited or removed shows there at once.
 * ponytail: every template is read per query; key them by mtime if a
 * vault's templates folder grows large.
 */
export async function refreshSlashTemplates(): Promise<void> {
  // One snapshot: openVault sets the vault and its tree together.
  const { currentVault, fileTree } = useVaultStore.getState();
  const vault = currentVault?.path;
  const files = templateFiles(fileTree);
  const read = await Promise.all(
    files.map((f) =>
      ipc.readFile(f.path).then(
        (c) => ({ name: f.name, raw: c.raw }),
        // Removed since the tree was listed: it is simply not offered.
        () => null,
      ),
    ),
  );
  // Another vault opened meanwhile: its own read decides.
  if (useVaultStore.getState().currentVault?.path !== vault) return;
  slashSources = { vault, files: read.filter((s) => s !== null) };
}

/** The `slash:` templates as `/` items, filled for the note titled `title`;
 *  none while the last read was of another vault. */
export function slashTemplates(
  title: string,
  now: Date = new Date(),
): SlashItem[] {
  if (slashSources.vault !== useVaultStore.getState().currentVault?.path)
    return [];
  const vars = templateVars(title, now);
  return slashSources.files.flatMap(
    (s) => templateSlashItem(s.name, s.raw, vars) ?? [],
  );
}

/** A `slash:` template makes a note without its menu keys and `${}` caret
 *  markers (a frontmatter left empty goes, with the blank lines after it);
 *  any other template is copied as it is. */
function noteText(raw: string): string {
  if (!normalizeQuery(fmText(parseFrontmatter(raw), "slash"))) return raw;
  const edit = patchFrontmatter(raw, {
    slash: undefined,
    slash_label: undefined,
    slash_section: undefined,
  });
  const text = edit.insert
    ? edit.raw
    : edit.raw.replace(/^(?:[ \t]*\r?\n)+/, "");
  return text.split("${}").join("");
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
 * Create `<dir>/<name>.md` (default: beside the open note, as ⌘N) from a
 * template and route into it. An existing stem
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
  // No folder given: where ⌘N would put it (S15). raw/ is refused either way.
  const path = await store.openWikilink(name, templateTargetDir(root, dir ?? defaultNoteDir()));
  if (!path) return null;
  // ipc, not saveFile: saveFile swallows failures into vaultStore.error.
  await ipc.writeFile(
    path,
    applyTemplate(noteText(tpl.raw), {
      date: today(),
      time: localTime(),
      title: name,
    }),
  );
  void store.refreshLinkGraph();
  setRoute(`page:${path}`);
  return path;
}
