// Topic-map (MOC) drafting (Phase B, Task 4). `distill.rs::run` detects a
// cluster that has grown big and mature enough and writes a `draft-map`
// proposal (see `propose_map_candidates`); once approved, this draws the
// actual `wiki/maps/<slug>.md` page via the query model — the LLM call
// itself deliberately lives here, not in Rust, the same split every other
// content-writing distill step already has (sessionDigest.ts, digests.ts).

import { ipc } from "./ipc";
import type { FileNode } from "./ipc";
import { complete } from "./chat";
import { stripFrontmatter } from "./markdown";
import { matchWikilinkAt } from "./wikilinks";

function mapSystemPrompt(cluster: string): string {
  return (
    `Write a topic map (Map of Content) for the '${cluster}' topic. Structure: one-paragraph ` +
    "overview, then grouped [[wikilinks]] to the member pages with one-line descriptions. Only " +
    "link to the member pages listed below — do not link to any other page. Cite nothing " +
    "external. Output markdown body only."
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

/** The `.md` file children of `${root}/wiki/maps` — same 2-level tree-descend
 *  shape as `distillStore.ts`'s `feedbackFileNodes`, kept as its own copy
 *  rather than shared: importing from `../stores/distillStore` here would
 *  cycle back (that module already imports `draftMap` from this file). */
function mapFileNodes(tree: FileNode[]): Extract<FileNode, { kind: "file" }>[] {
  const wiki = tree.find((n) => n.kind === "directory" && n.name === "wiki");
  if (!wiki || wiki.kind !== "directory") return [];
  const maps = wiki.children.find((n) => n.kind === "directory" && n.name === "maps");
  if (!maps || maps.kind !== "directory") return [];
  return maps.children.filter(
    (n): n is Extract<FileNode, { kind: "file" }> => n.kind === "file" && /\.md$/i.test(n.name),
  );
}

/** An existing `wiki/maps/*.md` page whose `cluster:` frontmatter already
 *  matches this cluster, if any — vault-relative path, or `null`. Matched by
 *  EITHER `cluster` (the label passed in) OR any of `memberStems` — the same
 *  drift-tolerance widening as the Rust-side dedup/anchor match: a cluster's
 *  label is its medoid stem, recomputed every ontology rebuild, so a map
 *  drafted for an OLD medoid must still be found even after the label has
 *  since drifted to a different (but still current) member. Checked before
 *  drafting so a crash between a previous draftMap's write and the caller's
 *  status->done rewrite never re-drafts the same cluster into a `-2` file on
 *  retry: "location is state," the same rule Rust's own map-exists dedup
 *  (`existing_map_clusters`) already applies. `ipc.readFile`'s `frontmatter`
 *  is already-parsed YAML (Rust's `vault::read_file`), so no hand-rolled
 *  frontmatter parsing is needed here. */
async function findExistingMapPath(
  vaultPath: string,
  cluster: string,
  memberStems: Set<string>,
): Promise<string | null> {
  const tree = await ipc.listFiles(vaultPath).catch(() => []);
  for (const f of mapFileNodes(tree)) {
    const file = await ipc.readFile(f.path).catch(() => null);
    const fm = file?.frontmatter as { cluster?: unknown } | null | undefined;
    if (typeof fm?.cluster !== "string") continue;
    if (fm.cluster === cluster || memberStems.has(fm.cluster.toLowerCase())) {
      return f.path.startsWith(`${vaultPath}/`) ? f.path.slice(vaultPath.length + 1) : f.path;
    }
  }
  return null;
}

/** Strip any `[[link]]` in `body` whose target isn't one of `allowedStems`
 *  (case-insensitive, matching how wikilinks actually resolve — lowercased
 *  in `index::build_name_index`) — a model that ignores the system prompt's
 *  "only link to the member pages" instruction gets its hallucinated
 *  citation degraded to plain text (its own display text, or the raw target
 *  if it had none) instead of a broken/misleading link left in the page.
 *  Returns the cleaned body and how many were stripped. */
function stripUnknownWikilinks(
  body: string,
  allowedStems: Set<string>,
): { body: string; strippedCount: number } {
  let out = "";
  let strippedCount = 0;
  for (let i = 0; i < body.length; ) {
    const m = body[i] === "[" ? matchWikilinkAt(body, i) : null;
    if (!m) {
      out += body[i];
      i++;
      continue;
    }
    if (allowedStems.has(m.target.toLowerCase())) {
      out += body.slice(i, m.end);
    } else {
      out += m.display;
      strippedCount++;
    }
    i = m.end;
  }
  return { body: out, strippedCount };
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
 *  vault-relative path.
 *
 *  `manifestId` is the undo-manifest the drafted file is recorded under. A
 *  caller drafting SEVERAL maps in one distill run must pass one shared id
 *  (`runDistillGuarded`'s auto-apply does) so the whole run stays reachable
 *  from a single "undo this run" — minting a fresh id per call fragmented a
 *  multi-map run into manifests only undoable one id at a time, and the
 *  Settings undo button only ever reaches the newest. The default (a fresh
 *  `llm-<now>` id) fits the other caller, distillStore's manual per-click
 *  approve, where one click IS the whole run. */
export async function draftMap(
  vaultPath: string,
  cluster: string,
  members: string[],
  manifestId = `llm-${Math.floor(Date.now() / 1000)}`,
): Promise<string> {
  const memberStems = new Set(members.map((m) => memberStem(m).toLowerCase()));
  const existing = await findExistingMapPath(vaultPath, cluster, memberStems);
  if (existing) return existing;

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
  const { body: safeBody, strippedCount } = stripUnknownWikilinks(clean, memberStems);
  if (strippedCount > 0) {
    console.warn(
      `[maps] draftMap(${cluster}): stripped ${strippedCount} wikilink(s) not in the member list`,
    );
  }

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
    `---\n\n${safeBody}\n`;

  try {
    await ipc.createFolder(`${vaultPath}/wiki`, "maps");
  } catch {
    /* already exists */
  }
  const path = await freeMapPath(vaultPath, slugify(cluster));
  await ipc.writeFile(path, content);
  const rel = path.startsWith(`${vaultPath}/`) ? path.slice(vaultPath.length + 1) : path;
  // Important 4 (Phase B whole-branch review): record the drafted file in an
  // undo-manifest so "undo this run" can remove it — same best-effort rule as
  // the other TS-step recordings (a bookkeeping failure must not fail the
  // draft that already succeeded).
  await ipc.appendDistillManifest(vaultPath, manifestId, [], [rel])
    .catch((e) => {
      console.error(`[maps] manifest append failed for ${rel}:`, e);
    });
  return rel;
}
