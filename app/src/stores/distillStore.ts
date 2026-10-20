// Distill feedback surface (Task 9, Phase A). Lists pending work/feedback/*.md
// proposals (parsed client-side from their frontmatter) alongside DistillStatus,
// so the sidebar badge, the Overview card, and PageFeedback share one source of
// truth instead of each polling the backend separately.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { FileNode, MycoSettings } from "../lib/ipc";
import type { DistillStatus } from "../lib/distill";
import { batchConfirm } from "../lib/quarantine";
import type { QuarantineGroup, QuarantineItem } from "../lib/quarantine";
import { draftMap } from "../lib/maps";
import { canGenerate, getActiveModel, roleFor } from "../lib/chat";
import { STRINGS } from "../lib/i18n";
import type { Strings } from "../lib/i18n";
import { getDeletionPolicy } from "./settingsStore";
import { confirmAction } from "./dialogStore";
import { useUIStore } from "./uiStore";
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

/** The `draft-map` proposals still awaiting a decision — the rows the activity
 *  surfaces (topbar popover + tray panel) offer approve/reject on. Only
 *  `pending`: an `approved` one is already decided and merely waiting for the
 *  draft-map generation step, so offering "approve" again would be a lie. */
export function pendingMapProposals(proposals: ProposalMeta[]): ProposalMeta[] {
  return proposals.filter(
    (p) => p.action === "draft-map" && p.status === "pending",
  );
}

/** An `archive-batch` proposal: only runs before the 2026-10-03 decision
 *  (B1, no run touches raw/) wrote them. Nothing applies one any more; it is
 *  marked done as it is found. */
function isRetired(p: Pick<ProposalMeta, "action">): boolean {
  return p.action === "archive-batch";
}

/** The line under a proposal card's title. An old raw/ archive proposal is
 *  no longer needed (listed only when marking it done failed). A `draft-map`
 *  with no writing model says so, pending or already approved: a retry cannot
 *  help until one is set. Otherwise a still-listed `approved` proposal is one
 *  whose apply failed after the pending -> approved rewrite (refresh() keeps
 *  only pending/approved, and a successful apply flips it to `done`). */
export function proposalNotice(
  p: ProposalMeta,
  needsWriter: boolean,
): "retired" | "needs-writer" | "failed" | null {
  if (isRetired(p)) return "retired";
  if (p.action === "draft-map" && needsWriter) return "needs-writer";
  return p.status === "approved" ? "failed" : null;
}

/** What approving `p` does, in one sentence from its kind — shown beside
 *  Approve and as the confirm's message (UX S20). A map carries no `files`
 *  (cluster/members instead), so a count would read "0". */
export function proposalOutcome(
  p: ProposalMeta,
  t: Pick<
    Strings,
    "pf_outcome_admit" | "pf_outcome_delete" | "pf_confirm_msg_draft_map" | "delete_permanent_msg"
  >,
  permanent = false,
): string {
  if (p.action === "draft-map") return t.pf_confirm_msg_draft_map;
  const line = p.action === "admit-cluster" ? t.pf_outcome_admit : permanent ? t.delete_permanent_msg : t.pf_outcome_delete;
  return line.replace("{n}", String(p.files.length));
}

/** Whether the generate role — the one `draftMap` calls — can write prose,
 *  checked the way `study.ts` does. */
async function hasWriter(): Promise<boolean> {
  const selected = await getActiveModel("organization");
  return canGenerate(selected.provider, selected.model);
}

/** The same check off already-loaded settings, for the activity popover and
 *  tray that read settingsStore. Settings not loaded yet claim nothing. */
export function settingsNeedWriter(s: MycoSettings | null): boolean {
  if (s === null) return false;
  // Display unavailable metadata without granting legacy fields execution rights.
  if (!s.model_roles?.roles?.organization) return true;
  const selected = roleFor("organization", s);
  return !canGenerate(selected.provider, selected.model);
}

/** An apply failure as the card's page shows it. The backend's
 *  CHAT_MODEL_MISSING is an English sentence about bundled chat models, so it
 *  becomes the localized needs-writer line, as `audioStore` does; any other
 *  error shows as it is. */
function applyErrorText(err: unknown): string {
  const msg = String(err);
  if (!msg.includes("no local chat model is bundled")) return msg;
  const t = STRINGS[useUIStore.getState().lang] ?? STRINGS.en;
  return t.pf_map_needs_writer ?? "Writing a topic map needs a model that can write";
}

export interface DistillState {
  status: DistillStatus | null;
  proposals: ProposalMeta[];
  /** `_inbox/quarantine/` items awaiting review (ROADMAP P0) — the Feedback
   *  page's second tab. Loaded by the same refresh() as the proposals. */
  quarantine: QuarantineItem[];
  loading: boolean;
  /** Set when the last proposal action failed. An `approved`-status proposal stays
   *  listed for exactly this reason — on-disk it's a recoverable in-flight
   *  decision, not a resolved one (`run()` deliberately never sweeps it), so
   *  the retry affordance in PageFeedback needs it to still be there. */
  error: string | null;
  /** True when no role can write a topic map, so a `draft-map` card says it
   *  needs a writing model instead of offering an approve that cannot run.
   *  Set by refresh() and by an apply() the gate stopped. */
  needsWriter: boolean;
  refresh: () => Promise<void>;
  /** `pending` proposals: rewrites status pending -> approved, then calls
   *  applyDistillProposal (which flips it to done on success). `approved`
   *  proposals (a retry, after a prior applyDistillProposal rejected): skips
   *  the rewrite — it's already approved — and just calls
   *  applyDistillProposal again. Always refreshes afterward, success or not.
   *  Returns the "moved N, skipped M" summary, or null on failure (with
   *  `error` set — the proposal itself is left `approved` and still listed,
   *  never silently dropped). */
  apply: (path: string, expectedPermanent?: boolean) => Promise<string | null>;
  /** Proposal paths with an apply in flight. A draft-map apply dedups against
   *  existing maps BEFORE its LLM call, so two overlapping applies of the SAME
   *  proposal (double-click, or the popover and the tray panel racing) both
   *  passed that check and wrote two pages for one cluster. */
  applying: Set<string>;
  /** Rewrites status -> dismissed (from whatever it currently is), then
   *  refreshes. Returns false on failure or without an open vault. */
  dismiss: (path: string) => Promise<boolean>;
  /** Quarantine review, all three by vault-relative content path. `restore`
   *  puts each item back where it came from (`readmit_quarantine`); `trash`
   *  deletes the item and sidecar under the confirmed policy in a few
   *  `trash_paths` calls; `keepLonger` pushes the sidecar TTL.
   *  Each refreshes afterwards and sets `error` instead of throwing. `restore`
   *  and `trash` take one item or a whole 격리-tab group. */
  restoreQuarantine: (paths: string[]) => Promise<void>;
  trashQuarantine: (paths: string[], expectedPermanent?: boolean) => Promise<void>;
  keepQuarantine: (path: string, days: number) => Promise<void>;
  /** What has a 격리-tab action in flight (`withQuarantineLock`): item paths,
   *  and a group key while that group's batch runs. */
  quarantineBusy: ReadonlySet<string>;
}

/** Items per OS-trash call in a 격리-tab batch: few calls, and still a count
 *  that visibly goes down on the measured 106-item group. */
const TRASH_CHUNK = 50;

/** Shared body of quarantine restore/trash: needs an open vault, clears
 *  the previous error, surfaces a failure as `error` rather than throwing at a
 *  click handler, and always refreshes so the list reflects the disk. The
 *  error is set after that refresh, which clears errors. */
async function runQuarantineAction(
  set: (partial: Partial<DistillState>) => void,
  get: () => DistillState,
  act: (vaultPath: string) => Promise<unknown>,
): Promise<void> {
  const vault = useVaultStore.getState().currentVault;
  if (!vault) return;
  set({ error: null });
  let failure: string | null = null;
  try {
    await act(vault.path);
  } catch (err) {
    failure = String(err);
  } finally {
    await get().refresh();
    if (failure) set({ error: failure });
  }
}

interface ProposalSession {
  path: string;
  token: string;
}

function proposalSession(): ProposalSession | null {
  const state = useVaultStore.getState();
  return state.currentVault && !state.isOpeningVault
    ? { path: state.currentVault.path, token: state.vaultToken }
    : null;
}

function ownsProposalSession(session: ProposalSession): boolean {
  const state = useVaultStore.getState();
  return !state.isOpeningVault && state.currentVault?.path === session.path &&
    state.vaultToken === session.token;
}

let refreshRequest = 0;
// UI locks reset with the session; an already-dispatched action still owns its file.
const proposalOwners = new Set<string>();

export const useDistillStore = create<DistillState>((set, get) => ({
  status: null,
  proposals: [],
  quarantine: [],
  loading: false,
  error: null,
  needsWriter: false,
  applying: new Set<string>(),
  quarantineBusy: new Set<string>(),

  async refresh() {
    // An error belongs to the action that raised it; a later refresh means
    // the list has moved on, so the red line goes too.
    const vault = proposalSession();
    const request = ++refreshRequest;
    if (!vault) {
      set({ status: null, proposals: [], quarantine: [], error: null, loading: false, needsWriter: false });
      return;
    }
    const isCurrent = () => request === refreshRequest && ownsProposalSession(vault);
    set({ loading: true, error: null });
    try {
      const [status, tree, quarantine, writer] = await Promise.all([
        ipc.distillStatus(vault.path),
        ipc.listFiles(vault.path),
        // An older backend without the command must not blank the proposals.
        ipc.listQuarantine(vault.path).catch(() => [] as QuarantineItem[]),
        // Unreadable settings claim nothing: apply() then reports the real error.
        hasWriter().catch(() => true),
      ]);
      if (!isCurrent()) return;
      const proposals: ProposalMeta[] = [];
      let retired = false;
      for (const f of feedbackFileNodes(tree)) {
        try {
          const file = await ipc.readFile(f.path);
          if (!isCurrent()) return;
          const parsed = parseProposal(toRelative(vault.path, f.path), file.raw);
          // `approved` stays listed too — it's an in-flight decision the user
          // already made, not a resolved one; only `done`/`dismissed` (swept
          // by run()'s own archive pass) drop off the list.
          if (!parsed || (parsed.status !== "pending" && parsed.status !== "approved")) continue;
          // Marked done here, as the next run would. A failed write leaves it
          // listed, with a card that says it is no longer needed.
          if (isRetired(parsed)) {
            const done = await ipc
              .writeFile(f.path, rewriteStatus(file.raw, "done"))
              .then(() => true, () => false);
            if (!isCurrent()) return;
            if (done) {
              retired = true;
              continue;
            }
          }
          proposals.push(parsed);
        } catch {
          if (!isCurrent()) return;
          /* one unreadable proposal file must not blank the whole list */
        }
      }
      // The badge count came from before the retire.
      const counted = retired ? await ipc.distillStatus(vault.path) : status;
      if (!isCurrent()) return;
      set({ status: counted, proposals, quarantine, needsWriter: !writer, loading: false });
    } catch {
      if (isCurrent()) set({ loading: false });
    }
  },

  async apply(path, expectedPermanent) {
    const vault = proposalSession();
    if (!vault) return null;
    const isCurrent = () => ownsProposalSession(vault);
    // One apply per proposal at a time — see `applying`.
    const full = `${vault.path}/${path}`;
    if (get().applying.has(path) || proposalOwners.has(full)) return null;
    proposalOwners.add(full);
    set({ error: null, applying: new Set(get().applying).add(path) });
    // Set after the closing refresh(), which clears errors.
    let failure: string | null = null;
    try {
      const file = await ipc.readFile(full);
      if (!isCurrent()) return null;
      const parsed = parseProposal(path, file.raw);
      // A map needs a model that writes. Without one, stop before any write:
      // a pending file stays pending, no model is called, and the card says
      // what is missing instead of showing an error.
      if (parsed?.action === "draft-map") {
        const writer = await hasWriter();
        if (!isCurrent()) return null;
        if (!writer) {
          set({ needsWriter: true });
          return null;
        }
      }
      // Nothing to apply: mark it done, as refresh() would have.
      if (parsed && isRetired(parsed)) {
        await ipc.writeFile(full, rewriteStatus(file.raw, "done"));
        return null;
      }
      // Only rewrite pending -> approved on the FIRST attempt. A retry (the
      // proposal is already `approved` because the previous applyDistillProposal
      // call failed after the rewrite succeeded) must not touch the file again.
      let raw = file.raw;
      if (parsed?.status === "pending") {
        raw = rewriteStatus(file.raw, "approved");
        await ipc.writeFile(full, raw);
        if (!isCurrent()) return null;
      }
      // draft-map completes entirely TS-side (the generate-role draft call
      // lives in lib/maps.ts) — apply_proposal's Rust command only knows the
      // three Phase A actions and errors on anything else, so this branch
      // never reaches it.
      if (parsed?.action === "draft-map") {
        if (!parsed.cluster || !parsed.members) {
          throw new Error(`draft-map proposal ${path} is missing its cluster/members payload`);
        }
        const rel = await draftMap(vault.path, parsed.cluster, parsed.members, undefined, isCurrent);
        if (!isCurrent()) return null;
        await ipc.writeFile(full, rewriteStatus(raw, "done"));
        return isCurrent() ? rel : null;
      }
      const result = await (expectedPermanent === undefined
        ? ipc.applyDistillProposal(vault.path, path)
        : ipc.applyDistillProposal(vault.path, path, expectedPermanent));
      return isCurrent() ? result : null;
    } catch (err) {
      failure = applyErrorText(err);
      return null;
    } finally {
      proposalOwners.delete(full);
      if (isCurrent()) {
        const next = new Set(get().applying);
        next.delete(path);
        set({ applying: next });
        // Refresh successes and failures only for their originating session.
        await get().refresh();
        if (isCurrent() && failure) set({ error: failure });
      }
    }
  },

  async restoreQuarantine(paths) {
    await runQuarantineAction(set, get, (vault) => ipc.restoreQuarantine(vault, paths));
  },

  async trashQuarantine(paths, expectedPermanent) {
    await runQuarantineAction(set, get, async (vault) => {
      // One deletion call per TRASH_CHUNK items with their sidecars, not one per
      // file. The native command applies the saved policy. A refresh between calls
      // shows the group shrink; a failure stops the batch, and the closing
      // refresh shows exactly what is still there. A sidecar a half-written
      // quarantine move never made is skipped backend-side.
      for (let i = 0; i < paths.length; i += TRASH_CHUNK) {
        if (i > 0) await get().refresh();
        await ipc.trashPaths(
          paths
            .slice(i, i + TRASH_CHUNK)
            .flatMap((p) => [
              `${vault}/${p}`,
              `${vault}/${p.replace(/\.[^./]+$/, "")}.verdict.json`,
            ]),
          ...expectedPermanent === undefined ? [] : [expectedPermanent],
        );
      }
    });
  },

  async keepQuarantine(path, days) {
    const vault = proposalSession();
    if (!vault) return;
    const isCurrent = () => ownsProposalSession(vault);
    set({ error: null });
    let failure: string | null = null;
    try {
      const origin = await ipc.agentVaultSession();
      if (!isCurrent()) return;
      if (origin.vaultPath !== vault.path || !origin.openingToken) {
        throw new Error("Keep requires the captured vault opening");
      }
      await ipc.extendQuarantine(vault.path, [path], days, origin);
    } catch (error) {
      failure = String(error);
    } finally {
      if (isCurrent()) {
        await get().refresh();
        if (isCurrent() && failure) set({ error: failure });
      }
    }
  },

  async dismiss(path) {
    const vault = proposalSession();
    if (!vault) return false;
    const isCurrent = () => ownsProposalSession(vault);
    const full = `${vault.path}/${path}`;
    set({ error: null });
    let failure: string | null = null;
    try {
      const file = await ipc.readFile(full);
      if (!isCurrent()) return false;
      await ipc.writeFile(full, rewriteStatus(file.raw, "dismissed"));
      return isCurrent();
    } catch (error) {
      failure = String(error);
      return false;
    } finally {
      if (isCurrent()) {
        await get().refresh();
        // The list refresh clears errors; preserve this action's failure after it.
        if (isCurrent() && failure) set({ error: failure });
      }
    }
  },
}));

// A new session must not retag the previous vault's proposals for native panels.
useVaultStore.subscribe((state, previous) => {
  if (state.vaultToken === previous.vaultToken &&
    state.currentVault?.path === previous.currentVault?.path) return;
  refreshRequest++;
  useDistillStore.setState({
    status: null, proposals: [], quarantine: [], loading: false, error: null,
    needsWriter: false, applying: new Set(), quarantineBusy: new Set(),
  });
});

// A tab switch clears the error too, so the 격리 tab does not carry the 제안
// tab's red line (and back).
useUIStore.subscribe((s, prev) => {
  if (s.feedbackTab !== prev.feedbackTab) useDistillStore.setState({ error: null });
});

/** Run `act` holding `key` in `quarantineBusy`, so the buttons it covers stay
 *  off and a double click can't fire two moves at the same file. Skipped while
 *  `key` is already held. Drops only its own key: another action finishing
 *  never unlocks a group whose batch still runs. Busy keys belong to the
 *  captured opening, so an old completion cannot unlock a reopened vault. */
export async function withQuarantineLock(
  key: string,
  act: () => Promise<unknown>,
): Promise<void> {
  const vault = proposalSession();
  if (!vault) return;
  const held = useDistillStore.getState().quarantineBusy;
  if (held.has(key)) return;
  useDistillStore.setState({ quarantineBusy: new Set(held).add(key) });
  try {
    await act();
  } finally {
    if (ownsProposalSession(vault)) {
      const next = new Set(useDistillStore.getState().quarantineBusy);
      next.delete(key);
      useDistillStore.setState({ quarantineBusy: next });
    }
  }
}

/** A 격리-tab group's "restore all" / "trash all": asks in the page first (the
 *  dialogStore modal, since Tauri swallows window.confirm), then acts on every
 *  item in the group under the group's lock. The lock waits for the answer, so
 *  the button that opened the dialog is still enabled when focus goes back to
 *  it. True when the owner confirmed. */
export async function confirmQuarantineBatch(
  action: "restore" | "trash",
  group: QuarantineGroup,
  t: Strings,
): Promise<boolean> {
  const permanent = action === "trash" ? getDeletionPolicy() : false;
  if (permanent === null) {
    useDistillStore.setState({ error: t.delete_policy_wait });
    return false;
  }
  if (!(await confirmAction(batchConfirm(action, group, t, permanent)))) return false;
  const paths = group.items.map((i) => i.path);
  const store = useDistillStore.getState();
  await withQuarantineLock(group.key, () =>
    action === "restore" ? store.restoreQuarantine(paths) : store.trashQuarantine(paths, permanent),
  );
  return true;
}
