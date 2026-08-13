// Distill feedback surface (Task 9, Phase A). Lists pending work/feedback/*.md
// proposals (parsed client-side from their frontmatter) alongside DistillStatus,
// so the sidebar badge, the Overview card, and PageFeedback share one source of
// truth instead of each polling the backend separately.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { FileNode } from "../lib/ipc";
import type { DistillStatus } from "../lib/distill";
import { draftMap } from "../lib/maps";
import { useVaultStore } from "./vaultStore";

export type ProposalAction =
  | "admit-cluster"
  | "archive-batch"
  | "delete-batch"
  | "draft-map";
export type ProposalStatus = "pending" | "approved" | "dismissed" | "done";

export interface ProposalMeta {
  /** Vault-relative path — what ipc.applyDistillProposal and ipc.writeFile's
   *  caller-side full-path join both key off. */
  path: string;
  action: ProposalAction;
  status: ProposalStatus;
  created: string;
  title: string;
  /** Full file content (frontmatter + body). `Viewer` strips the frontmatter
   *  itself, so this can be handed to it directly for the "expand" preview. */
  raw: string;
  files: string[];
  /** `draft-map` only — the cluster label and its kept member paths, straight
   *  off `payload.cluster`/`payload.members` (`propose_map_candidates`'
   *  payload shape, distinct from `files`). */
  cluster?: string;
  members?: string[];
}

/** Parse a `work/feedback/*.md` proposal's frontmatter + title. Line-based, not
 *  a full YAML parser — same technique as `lib/taskAgents.ts`'s `parseAgent`,
 *  which is enough because `write_proposal` (distill.rs) only ever emits flat,
 *  single-line-valued keys. Returns null for anything that isn't a
 *  `type: distill-proposal` file. */
export function parseProposal(path: string, raw: string): ProposalMeta | null {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!fm) return null;
  const meta: Record<string, string> = {};
  for (const line of fm[1].split("\n")) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2];
  }
  if (meta.type !== "distill-proposal") return null;

  const body = raw.slice(fm[0].length);
  const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? path;

  let files: string[] = [];
  let cluster: string | undefined;
  let members: string[] | undefined;
  try {
    const payload = JSON.parse(meta.payload ?? "{}") as {
      files?: string[];
      cluster?: string;
      members?: string[];
    };
    if (Array.isArray(payload.files)) files = payload.files;
    if (typeof payload.cluster === "string") cluster = payload.cluster;
    if (Array.isArray(payload.members)) members = payload.members;
  } catch {
    /* malformed payload — proposal still shows, just with no file list */
  }

  return {
    path,
    action: (meta.action as ProposalAction) ?? "admit-cluster",
    status: (meta.status as ProposalStatus) ?? "pending",
    created: meta.created ?? "",
    title,
    raw,
    files,
    cluster,
    members,
  };
}

/** The `.md` file children of `${root}/work/feedback` — NOT its nested
 *  `archive/` subfolder (run() auto-archives resolved proposals there), which
 *  is naturally excluded since only the feedback dir's own FILE children are
 *  taken, never its subdirectories. Exported: `lib/distill.ts`'s post-run
 *  auto-apply bridge (Task 4, Phase B) scans the same tree. */
export function feedbackFileNodes(
  tree: FileNode[],
): Extract<FileNode, { kind: "file" }>[] {
  const work = tree.find((n) => n.kind === "directory" && n.name === "work");
  if (!work || work.kind !== "directory") return [];
  const feedback = work.children.find(
    (n) => n.kind === "directory" && n.name === "feedback",
  );
  if (!feedback || feedback.kind !== "directory") return [];
  return feedback.children.filter(
    (n): n is Extract<FileNode, { kind: "file" }> =>
      n.kind === "file" && /\.md$/i.test(n.name),
  );
}

/** Absolute -> vault-relative, matching the idiom `lib/vaultPulse.ts` uses for
 *  the same conversion (mtimes come back absolute; the rest of the app keys
 *  vault content by relative path). Exported for the same reason as
 *  `feedbackFileNodes` above. */
export function toRelative(vaultRoot: string, absPath: string): string {
  const prefix = vaultRoot.endsWith("/") ? vaultRoot : `${vaultRoot}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

/** Flip the proposal's frontmatter `status:` line in place — mirrors the
 *  Rust-side `set_proposal_status`'s "line-level rewrite inside the first
 *  `---`...`---` block only" contract, so no other frontmatter key is
 *  touched. Exported for the same reason as `feedbackFileNodes` above. */
export function rewriteStatus(raw: string, next: ProposalStatus): string {
  return raw.replace(/^status:\s*\S+\s*$/m, `status: ${next}`);
}

export interface DistillState {
  status: DistillStatus | null;
  proposals: ProposalMeta[];
  loading: boolean;
  /** Set when the last `apply()` failed. An `approved`-status proposal stays
   *  listed for exactly this reason — on-disk it's a recoverable in-flight
   *  decision, not a resolved one (`run()` deliberately never sweeps it), so
   *  the retry affordance in PageFeedback needs it to still be there. */
  error: string | null;
  refresh: () => Promise<void>;
  /** `pending` proposals: rewrites status pending -> approved, then calls
   *  applyDistillProposal (which flips it to done on success). `approved`
   *  proposals (a retry, after a prior applyDistillProposal rejected): skips
   *  the rewrite — it's already approved — and just calls
   *  applyDistillProposal again. Always refreshes afterward, success or not.
   *  Returns the "moved N, skipped M" summary, or null on failure (with
   *  `error` set — the proposal itself is left `approved` and still listed,
   *  never silently dropped). */
  apply: (path: string) => Promise<string | null>;
  /** Rewrites status -> dismissed (from whatever it currently is), then
   *  refreshes. */
  dismiss: (path: string) => Promise<void>;
}

export const useDistillStore = create<DistillState>((set, get) => ({
  status: null,
  proposals: [],
  loading: false,
  error: null,

  async refresh() {
    const vault = useVaultStore.getState().currentVault;
    if (!vault) {
      set({ status: null, proposals: [] });
      return;
    }
    set({ loading: true });
    try {
      const [status, tree] = await Promise.all([
        ipc.distillStatus(vault.path),
        ipc.listFiles(vault.path),
      ]);
      const proposals: ProposalMeta[] = [];
      for (const f of feedbackFileNodes(tree)) {
        try {
          const file = await ipc.readFile(f.path);
          const parsed = parseProposal(toRelative(vault.path, f.path), file.raw);
          // `approved` stays listed too — it's an in-flight decision the user
          // already made, not a resolved one; only `done`/`dismissed` (swept
          // by run()'s own archive pass) drop off the list.
          if (parsed && (parsed.status === "pending" || parsed.status === "approved")) {
            proposals.push(parsed);
          }
        } catch {
          /* one unreadable proposal file must not blank the whole list */
        }
      }
      set({ status, proposals, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  async apply(path) {
    const vault = useVaultStore.getState().currentVault;
    if (!vault) return null;
    const full = `${vault.path}/${path}`;
    set({ error: null });
    try {
      const file = await ipc.readFile(full);
      const parsed = parseProposal(path, file.raw);
      // Only rewrite pending -> approved on the FIRST attempt. A retry (the
      // proposal is already `approved` because the previous applyDistillProposal
      // call failed after the rewrite succeeded) must not touch the file again.
      let raw = file.raw;
      if (parsed?.status === "pending") {
        raw = rewriteStatus(file.raw, "approved");
        await ipc.writeFile(full, raw);
      }
      // draft-map completes entirely TS-side (the query-model draft call
      // lives in lib/maps.ts) — apply_proposal's Rust command only knows the
      // three Phase A actions and errors on anything else, so this branch
      // never reaches it.
      if (parsed?.action === "draft-map") {
        if (!parsed.cluster || !parsed.members) {
          throw new Error(`draft-map proposal ${path} is missing its cluster/members payload`);
        }
        const rel = await draftMap(vault.path, parsed.cluster, parsed.members);
        await ipc.writeFile(full, rewriteStatus(raw, "done"));
        return rel;
      }
      return await ipc.applyDistillProposal(vault.path, path);
    } catch (err) {
      set({ error: String(err) });
      return null;
    } finally {
      // Always — success or failure — so an `approved`-but-failed proposal's
      // current on-disk state is what the list reflects, not what apply()
      // hoped would happen.
      await get().refresh();
    }
  },

  async dismiss(path) {
    const vault = useVaultStore.getState().currentVault;
    if (!vault) return;
    const full = `${vault.path}/${path}`;
    try {
      const file = await ipc.readFile(full);
      await ipc.writeFile(full, rewriteStatus(file.raw, "dismissed"));
    } catch {
      /* best-effort — refresh() below just leaves it showing if the write failed */
    }
    await get().refresh();
  },
}));
