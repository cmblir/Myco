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
 * equivalent of distill.rs's strip_atx_heading, simplified: full-tier items
 * feed the ingest prompt's title, not the summary-tier digest line, so there
 * is no frontmatter-stripping/truncation need here. */
function titleFromContent(content: string, fallback: string): string {
  const m = content.match(/^#{1,6}\s+(.+)$/m);
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
 * DECISION (`_inbox/` items): promoted to `raw/<slug>.md` first — via the
 * same `availableRawPath` + `writeFile` + `archiveInboxSource` sequence
 * `autoIngest.ts`'s `runInboxPass` uses for its own inbox sources — rather
 * than ingested in place. `INGEST_PROMPT` hardcodes `raw/${slug}.md` as the
 * path it tells the model to read; ingesting an `_inbox/` file in place would
 * hand the model a path that does not exist. Promoting also means Phase A's
 * raw/-only archive pass (`distill::run`'s "already represented" step) can
 * retire it later like any other raw source — left in `_inbox/`, it would
 * never be swept (that pass never walks `_inbox/`), unlike the brief's
 * speculative "ingest in place" v1. `archiveInboxSource` already exists on
 * this app's ipc (unlike the brief's uncertainty about it) and the whole
 * sequence is three already-existing ipc calls, so this is not a bigger diff
 * than the in-place alternative — it is the smallest option that is also
 * correct.
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

  let ingested = 0;
  const errors: string[] = [];
  for (const rel of items) {
    try {
      let sourceRel = rel;
      let content: string;
      if (rel.startsWith("_inbox/")) {
        content = (await ipc.readFile(`${vaultPath}/${rel}`)).raw;
        sourceRel = await ipc.availableRawPath(stemOf(rel));
        await ipc.writeFile(`${vaultPath}/${sourceRel}`, content);
        await ipc.archiveInboxSource(`${vaultPath}/${rel}`);
      } else {
        content = (await ipc.readFile(`${vaultPath}/${rel}`)).raw;
      }

      const slug = stemOf(sourceRel);
      const title = titleFromContent(content, slug);
      const prompt = INGEST_PROMPT(slug, title, [], []);

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
