// Full-tier ingest execution (Phase B, Task 3). The distill gate's ontology
// admission pass (Rust `ontology::admit`, via `scan`) tags some `_inbox/`/
// `raw/` items `Tier::Full` — worth a real LLM ingest, not just a one-line
// digest. This module drains that ledger through the SAME prompt + provider
// machinery interactive Ingest uses (`INGEST_PROMPT` + `runIngestProvider`,
// both exported from ingestStore.ts) rather than a second hand-maintained
// implementation, budgeted so one automatic pass cannot run away with LLM
// spend.
//
// This runs headless — no Zustand store, no stage UI, no `claude-stream`
// event listener — so it always uses non-streaming providers. anthropic-cli
// therefore calls `ipc.claudeRun` (the blocking variant `chat.ts`'s query
// path also uses) directly instead of `runIngestProvider`, which does not
// cover that provider — see `runIngestProvider`'s own doc comment for why.

import { ipc } from "./ipc";
import { getActiveModel } from "./chat";
import { stripFrontmatter } from "./markdown";
import { loadProfile } from "./profile";
import { INGEST_PROMPT, runIngestProvider } from "../stores/ingestStore";

export interface FullTierOutcome {
  ingested: number;
  skipped: "no-provider" | "nothing" | null;
  errors: string[];
}

// Fallback llm_ingest_budget when getDistillConfig is unavailable — mirrors
// DistillConfig's Rust-side default (distill.rs's d_ingest_budget), same
// fallback idiom as sessionDigest.ts's DEFAULT_DIGEST_DAYS.
const DEFAULT_INGEST_BUDGET = 3;

/** First ATX heading (`#`..`######`) in `content`, else `fallback` — TS-side
 * equivalent of distill.rs's strip_atx_heading. Frontmatter is stripped
 * first (reusing markdown.ts's own helper): a real `_inbox/` import always
 * opens with a YAML block, and a `#`-led line inside it (a YAML comment, not
 * a heading) would otherwise be mismatched as the title. Scans only the
 * first 40 lines of the body — the title is always near the top, and this
 * bounds the regex scan on a pathologically long source. */
function titleFromContent(content: string, fallback: string): string {
  const body = stripFrontmatter(content).split("\n").slice(0, 40).join("\n");
  const m = body.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function stemOf(rel: string): string {
  return rel.split("/").pop()!.replace(/\.md$/, "");
}

/** Runs the existing ingest pipeline over every gate-admitted Full-tier item
 * (`ipc.fullTierItems`, oldest first), up to `llm_ingest_budget` items —
 * the per-run LLM-cost cap, same idea as `runSessionDigest`'s
 * `llm_digest_days`. Called from `runDistillGuarded` after the session
 * digest, inside the same guard window.
 *
 * DECISION (`_inbox/` items): promoted to `raw/<slug>.md` — via
 * `archiveInboxSource` + `availableRawPath` + `writeFile`, same three ipc
 * calls `autoIngest.ts`'s `runInboxPass` uses for its own inbox sources —
 * rather than ingested in place. `INGEST_PROMPT` hardcodes `raw/${slug}.md`
 * as the path it tells the model to read; ingesting an `_inbox/` file in
 * place would hand the model a path that does not exist. Promoting also
 * means Phase A's raw/-only archive pass (`distill::run`'s "already
 * represented" step) can retire it later like any other raw source — left in
 * `_inbox/`, it would never be swept (that pass never walks `_inbox/`).
 *
 * Order matters and is deliberately archive-BEFORE-write (not write-then-
 * archive): `archiveInboxSource` moves the original into `_inbox/.archived/`
 * — dot-prefixed, so `vault_entries`/`collect_candidates` never walk it, no
 * second scoring possible once it lands there. That makes every failure mode
 * safe with no rollback/delete needed at all (an earlier version of this
 * function tried to roll back by deleting the raw copy on an archive
 * failure — unworkable, because `delete_path` unconditionally refuses any
 * `raw/` path, immutability rule, no "our own recent write" exception; the
 * "rollback" silently never ran against the real backend):
 *   - `archiveInboxSource` fails: nothing has been written yet — the item is
 *     collected as an error, original untouched in `_inbox/`, retried next
 *     pass exactly as before.
 *   - `writeFile` fails after a successful archive: the original is already
 *     safely in `_inbox/.archived/` (content preserved, walk-invisible) —
 *     the item is collected as an error and effectively retired; a human can
 *     recover it from `.archived/` by hand, but nothing duplicates.
 *   - ingest itself fails after archive+write both succeeded: the raw copy
 *     stays on disk and is a legitimate NEW, unscored `raw/` file — the next
 *     scan scores and offers it again on its own. No duplicate, because the
 *     `_inbox/` original is already archived (walk-invisible).
 *
 * No retry: an item whose read/promote/ingest throws is recorded in `errors`
 * and the loop moves to the next one. The next scan/ingest pass offers it
 * again on its own (same ledger tier, unchanged content hash).
 *
 * Validation (`ipc.validateIngest`) is deliberately skipped (v1): this path
 * has no UI to surface a validation failure to, and the nightly distill lint
 * plus the CLI's own self-reported ingest report already catch problems. */
export async function runFullTierIngest(vaultPath: string): Promise<FullTierOutcome> {
  const { provider, model } = await getActiveModel("ingest");
  if (provider === "builtin-local") {
    return { ingested: 0, skipped: "no-provider", errors: [] };
  }
  if (provider === "myco-pro") {
    const settings = await ipc.getSettings();
    if (!settings.providers.myco_pro) {
      return { ingested: 0, skipped: "no-provider", errors: [] };
    }
  }

  const cfg = await ipc.getDistillConfig(vaultPath).catch(() => null);
  const budget = cfg?.llm_ingest_budget ?? DEFAULT_INGEST_BUDGET;
  const items = (await ipc.fullTierItems(vaultPath)).slice(0, budget);
  if (items.length === 0) {
    return { ingested: 0, skipped: "nothing", errors: [] };
  }

  // Phase B, Task 6 — same grounding line startIngest passes, computed once
  // for the whole run rather than per item (the profile does not change
  // mid-run), and gated on the same `profile_injection` toggle for the same
  // reason (see startIngest's comment): this line is still profile content
  // sent to a provider. `cfg` above already failed CLOSED (`?? null` on a
  // read error) — no profile, no interests line.
  const profile = cfg?.profile_injection ? await loadProfile(vaultPath) : null;
  const profileInterests = profile?.interests.join(", ") ?? "";

  // Important 4 (Phase B whole-branch review): one manifest per RUN — every
  // _inbox/ archive-move + raw/ create this run performs lands in the SAME
  // undo-manifest Rust's own passes already write incrementally, so "undo
  // this run" can reverse them too. Recorded per item, right after the
  // move/write (not batched at the end), to keep the manifest close to the
  // actual file mtimes for undo's own "modified since the run" check.
  const manifestId = `llm-${Math.floor(Date.now() / 1000)}`;

  let ingested = 0;
  const errors: string[] = [];
  for (const rel of items) {
    try {
      let sourceRel = rel;
      let content: string;
      if (rel.startsWith("_inbox/")) {
        content = (await ipc.readFile(`${vaultPath}/${rel}`)).raw;
        // Archive BEFORE writing the raw copy — see the archive-before-write
        // ordering note above for why this makes every failure mode safe.
        const archivedAbs = await ipc.archiveInboxSource(`${vaultPath}/${rel}`);
        sourceRel = await ipc.availableRawPath(stemOf(rel));
        await ipc.writeFile(`${vaultPath}/${sourceRel}`, content);
        const archivedRel = archivedAbs.startsWith(`${vaultPath}/`)
          ? archivedAbs.slice(vaultPath.length + 1)
          : archivedAbs;
        await ipc
          .appendDistillManifest(
            vaultPath,
            manifestId,
            [{ from: rel, to: archivedRel }],
            [sourceRel],
          )
          .catch((e) => {
            console.error(`[distill] manifest append failed for ${rel}:`, e);
          });
      } else {
        content = (await ipc.readFile(`${vaultPath}/${rel}`)).raw;
      }

      const slug = stemOf(sourceRel);
      const title = titleFromContent(content, slug);
      const prompt = INGEST_PROMPT(slug, title, [], [], profileInterests);

      if (provider === "anthropic-cli") {
        const res = await ipc.claudeRun(prompt, vaultPath, model || undefined);
        if (res.status !== 0) {
          throw new Error(res.stderr.trim() || `claude exit ${res.status}`);
        }
      } else {
        await runIngestProvider({ provider, vaultPath, prompt, slug, title, body: content });
      }
      // On success: nothing else. Phase A's next archive pass sees
      // wiki/source-<slug>.md and retires the raw file with full
      // manifest/undo — the designed handoff between the two systems.
      ingested++;
    } catch (err) {
      errors.push(`${rel}: ${String(err)}`);
    }
  }
  return { ingested, skipped: null, errors };
}
