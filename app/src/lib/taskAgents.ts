// Task-agent presets (Feature 4). A saved agent is a portable markdown file
// under the vault's `agents/<slug>.md`: YAML frontmatter for the metadata
// (name, model, allowed tool subset, write permission) and the markdown body as
// the system prompt. Plain files ⇒ no lock-in; Obsidian/git see them too.

import { ipc } from "./ipc";
import type { FileNode } from "./ipc";

const AGENTS_DIR = "agents";

export interface TaskAgent {
  /** Filename stem, e.g. "contradiction-finder". */
  slug: string;
  path: string;
  name: string;
  model: string;
  /** Tool names this preset may use (empty ⇒ all read tools). */
  tools: string[];
  /** Whether the preset is allowed to use write tools. */
  allowWrite: boolean;
  /** The system prompt (markdown body). */
  systemPrompt: string;
}

export function agentsDir(vaultPath: string): string {
  return `${vaultPath}/${AGENTS_DIR}`;
}

export function agentSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/\.md$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

/** Paths of every `agents/*.md` preset in the vault tree. */
export function agentFiles(tree: FileNode[]): string[] {
  const dir = tree.find((n) => n.kind === "directory" && n.name === AGENTS_DIR);
  if (!dir || dir.kind !== "directory") return [];
  return dir.children
    .filter((c) => c.kind === "file" && /\.md$/i.test(c.name))
    .map((c) => c.path);
}

/** Serialize a preset to `agents/<slug>.md` markdown (frontmatter + body). */
export function serializeAgent(a: {
  name: string;
  model: string;
  tools: string[];
  allowWrite: boolean;
  systemPrompt: string;
}): string {
  const toolsYaml = a.tools.length
    ? `[${a.tools.map((t) => JSON.stringify(t)).join(", ")}]`
    : "[]";
  return (
    `---\n` +
    `name: ${JSON.stringify(a.name)}\n` +
    `model: ${JSON.stringify(a.model)}\n` +
    `tools: ${toolsYaml}\n` +
    `allow_write: ${a.allowWrite}\n` +
    `---\n\n` +
    `${a.systemPrompt.trim()}\n`
  );
}

/** Parse a preset's frontmatter + body. Lenient: missing keys get defaults. */
export function parseAgent(slug: string, path: string, raw: string): TaskAgent {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const body = fm ? raw.slice(fm[0].length) : raw;
  const meta: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
      if (m) meta[m[1]] = m[2];
    }
  }
  const unquote = (s: string | undefined): string =>
    (s ?? "").replace(/^["']|["']$/g, "");
  let tools: string[] = [];
  try {
    if (meta.tools) tools = JSON.parse(meta.tools);
  } catch {
    /* malformed tools list ⇒ treat as all read tools */
  }
  return {
    slug,
    path,
    name: unquote(meta.name) || slug,
    model: unquote(meta.model),
    tools: Array.isArray(tools) ? tools : [],
    allowWrite: meta.allow_write === "true",
    systemPrompt: body.trim(),
  };
}

export async function loadAgent(path: string): Promise<TaskAgent> {
  const file = await ipc.readFile(path);
  const slug = (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, "");
  return parseAgent(slug, path, file.raw);
}

export async function loadAgents(tree: FileNode[]): Promise<TaskAgent[]> {
  const out: TaskAgent[] = [];
  for (const path of agentFiles(tree)) {
    try {
      out.push(await loadAgent(path));
    } catch {
      /* skip unreadable preset */
    }
  }
  return out;
}

export async function saveAgent(
  vaultPath: string,
  preset: {
    name: string;
    model: string;
    tools: string[];
    allowWrite: boolean;
    systemPrompt: string;
  },
): Promise<string> {
  try {
    await ipc.createFolder(vaultPath, AGENTS_DIR);
  } catch {
    /* already exists */
  }
  const path = `${agentsDir(vaultPath)}/${agentSlug(preset.name)}.md`;
  await ipc.writeFile(path, serializeAgent(preset));
  return path;
}
