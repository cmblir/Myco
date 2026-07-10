// Digest generation (Feature 7). Runs a schedule's prompt over the wiki using
// the existing LLM stack and writes a plain-markdown digest note into the vault
// (default `digests/`). Reused by both the in-app timer and a manual "Run now".
// Outputs are portable, git-tracked notes; raw/ is never touched.

import { ipc } from "./ipc";
import { complete } from "./chat";
import type { Schedule } from "./ipc";

const SYSTEM =
  "You are Memex's digest writer. Produce a concise, well-structured markdown " +
  "digest grounded ONLY in the user's wiki. Cite pages inline as [[page-stem]]. " +
  "Use short sections and bullet points. Do not invent sources.";

export function digestSlug(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "digest"
  );
}

/** Build the user prompt for a schedule, folding in git history for `changed`. */
export async function buildPrompt(
  vaultPath: string,
  schedule: Schedule,
): Promise<string> {
  switch (schedule.kind) {
    case "changed": {
      const commits = await ipc.gitLog(vaultPath, 20).catch(() => []);
      const log = commits
        .map((c) => `- ${c.date} ${c.subject} (+${c.created}/~${c.modified})`)
        .join("\n");
      return (
        "Summarize what changed in the wiki recently, grouping related edits and " +
        "highlighting new or substantially updated pages. Recent commits:\n\n" +
        (log || "(no git history available)")
      );
    }
    case "stale":
      return (
        "Review the wiki for maintenance needs: orphan pages (no links), " +
        "under-cited claims, and any contradictions between pages. List the " +
        "weakest pages with a concrete next action for each."
      );
    case "topic":
      return (
        `Gather and summarize what the wiki currently says about: ${schedule.prompt}. ` +
        "Note gaps worth researching next."
      );
    case "query":
    default:
      return schedule.prompt;
  }
}

export function formatDigest(
  schedule: Schedule,
  body: string,
  dateIso: string,
): string {
  return (
    `---\n` +
    `title: ${JSON.stringify(schedule.title)}\n` +
    `kind: ${schedule.kind}\n` +
    `schedule: ${schedule.id}\n` +
    `generated: ${dateIso}\n` +
    `---\n\n` +
    `# ${schedule.title}\n\n` +
    `${body.trim()}\n`
  );
}

/** Run a schedule's digest and write the note. Returns the new note's path. */
export async function runDigest(
  vaultPath: string,
  schedule: Schedule,
  dateIso: string,
): Promise<string> {
  const prompt = await buildPrompt(vaultPath, schedule);
  const body = await complete({
    task: "query",
    cwd: vaultPath,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ],
  });
  const dir = schedule.output_dir || "digests";
  try {
    await ipc.createFolder(vaultPath, dir);
  } catch {
    /* already exists */
  }
  const day = dateIso.slice(0, 10);
  const path = `${vaultPath}/${dir}/${day}-${digestSlug(schedule.title)}.md`;
  await ipc.writeFile(path, formatDigest(schedule, body, dateIso));
  return path;
}
