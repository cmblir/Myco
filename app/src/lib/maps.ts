// Topic-map (MOC) drafting (Phase B, Task 4). `distill.rs::run` detects a
// cluster that has grown big and mature enough and writes a `draft-map`
// proposal (see `propose_map_candidates`); once approved, this draws the
// actual `wiki/maps/<slug>.md` page via the query model — the LLM call
// itself deliberately lives here, not in Rust, the same split every other
// content-writing distill step already has (sessionDigest.ts, digests.ts).

import { ipc } from "./ipc";
import { complete } from "./chat";
import { stripFrontmatter } from "./markdown";

function mapSystemPrompt(cluster: string): string {
  return (
    `Write a topic map (Map of Content) for the '${cluster}' topic. Structure: one-paragraph ` +
    "overview, then grouped [[wikilinks]] to the member pages with one-line descriptions. Cite " +
    "nothing external. Output markdown body only."
  );
}

/** `wiki/foo/bar-baz.md` -> `bar-baz` — wikilinks in this vault resolve by
 *  page stem (`index::build_name_index`), not by full path, so the model
 *  needs stems, not the cluster's raw member paths, to link correctly. */
function memberStem(rel: string): string {
  const name = rel.split("/").pop() ?? rel;
  return name.replace(/\.md$/i, "");
}

function userPrompt(members: string[]): string {
  const list = members.map((m) => `- [[${memberStem(m)}]]`).join("\n");
  return `Member pages:\n${list}\n\nWrite the topic map body now.`;
}

/** Lowercase, dash-separated slug for the map's filename — same shape as
 *  Rust's `distill::slugify` (proposal filenames), so a cluster's proposal
 *  and its drafted map read as the same name. */
function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "map"
  );
}

/** `wiki/maps/<slug>[-N].md`, avoiding a collision the same way Rust's
 *  `free_path` does (`-2`, `-3`… before a taken name) — probed via readFile,
 *  which rejects when nothing is there, since there is no generic
 *  "does this path exist" ipc call. */
async function freeMapPath(vaultPath: string, slug: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${slug}.md` : `${slug}-${n}.md`;
    const path = `${vaultPath}/wiki/maps/${name}`;
    const exists = await ipc.readFile(path).then(
      () => true,
      () => false,
    );
    if (!exists) return path;
  }
}

/** Draft a topic map for `cluster` from its (already-approved) `members`,
 *  and write it to `wiki/maps/<slug(cluster)>.md`. Frontmatter is written by
 *  code, never by the model, with `status: draft` — a human still reviews
 *  the result before it counts as a settled wiki page. Returns the written
 *  vault-relative path. */
export async function draftMap(
  vaultPath: string,
  cluster: string,
  members: string[],
): Promise<string> {
  const body = await complete({
    task: "query",
    cwd: vaultPath,
    messages: [
      { role: "system", content: mapSystemPrompt(cluster) },
      { role: "user", content: userPrompt(members) },
    ],
  });
  // Guard: the system prompt asks for "markdown body only", but a model can
  // still emit its own frontmatter fence out of habit — strip it so code's
  // own frontmatter block below is the only one in the file.
  const clean = stripFrontmatter(body).trim();

  const created = new Date().toISOString().slice(0, 10);
  const content =
    `---\n` +
    `title: ${JSON.stringify(`Map: ${cluster}`)}\n` +
    `type: map\n` +
    `cluster: ${JSON.stringify(cluster)}\n` +
    `created: ${created}\n` +
    `confidence: medium\n` +
    `status: draft\n` +
    `tags: [map]\n` +
    `---\n\n${clean}\n`;

  try {
    await ipc.createFolder(`${vaultPath}/wiki`, "maps");
  } catch {
    /* already exists */
  }
  const path = await freeMapPath(vaultPath, slugify(cluster));
  await ipc.writeFile(path, content);
  return path.startsWith(`${vaultPath}/`) ? path.slice(vaultPath.length + 1) : path;
}
