import type { RoleUsage } from "../lib/modelRoles";
import { isBuiltinChatModel } from "../lib/providers";
// Reflect run state (FEAT-06). "Reflect" is a read-only LLM pass that proposes
// concrete wiki improvements (orphans to link, stale pages, missing
// cross-references). Lifted into a store — like lintStore — so a run survives
// navigating between pages, and so the scheduler (autoReflect.ts) and any
// manual trigger share one source of truth.
//
// Unlike lint, reflect never streams: it uses the blocking complete({task:
// "query", …}) path, which works with any provider, and parses the model's
// bulleted output into a list of suggestions. It NEVER modifies files.

import { create } from "zustand";
import { complete } from "../lib/chat";
import { displayName } from "../lib/displayName";
import { flattenMarkdown, isNonKnowledgePath, stem } from "../lib/graphData";
import { isMalformedLinkName } from "../lib/graphGaps";
import { STRINGS } from "../lib/i18n";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { AgentVaultSession } from "../lib/ipc";
import { mmrSelect } from "../lib/sessionDigest";
import { classifyTopLevel, vaultRel } from "../lib/vaultAreas";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";
import HEADS from "../lib/mycoPromptHeads.json";

// Extractive findings are OUR prose, not a model's, so they follow the UI
// language — read off uiStore directly, the ingestStore idiom for store-side
// user-facing text.
function t(): (typeof STRINGS)["en"] {
  return STRINGS[useUIStore.getState().lang] ?? STRINGS.en;
}

const REFLECT_PROMPT = `${HEADS.reflect} Read the vault and propose concrete, actionable improvements.

Focus on:
- Orphan pages that no other page links to (suggest which existing pages should link to them).
- Stale pages (status: active but not updated recently) worth revisiting.
- Missing cross-references: concepts/entities mentioned in prose that have their own page but aren't linked with [[wikilinks]].

Output a SHORT bulleted list (one "- " item per line, at most 8 items). Each item names a specific file and a one-line action. This is read-only analysis — do NOT create, edit, or delete any files.`;

export type ReflectStage = "idle" | "running" | "done" | "error";

/** One finding. `text` is the display line (localized prose, always present);
 * the other fields say what the finding is ABOUT, which is the only reason a
 * suggestion can be acted on at all. Only the extractive path fills them — it
 * derives findings from the link graph, so it knows the page and the link name
 * before it writes the sentence. The LLM path emits prose we would have to
 * parse back into structure, which is exactly the fragile step worth skipping:
 * those items carry `text` alone and the panel offers them no action. */
export type ReflectSuggestion =
  /** Model prose — display only. */
  | { text: string; kind?: undefined }
  /** A page nothing links to. Nothing can be auto-written here: choosing where
   *  the link should come from is judgment. The honest action is opening it, so
   *  `page` is the absolute path (a `page:` route id). */
  | { text: string; kind: "orphan"; page: string }
  /** A page links to `[[link]]`, which has no page. Creating that page is a
   *  real, safe action — the whole point of the bulk button. `from` is the
   *  page holding the link (absolute), which the row's title names. */
  | { text: string; kind: "unresolved"; link: string; from: string };

type UnresolvedSuggestion = Extract<ReflectSuggestion, { kind: "unresolved" }>;

const isUnresolved = (s: ReflectSuggestion): s is UnresolvedSuggestion =>
  s.kind === "unresolved";

interface ReflectState {
  stage: ReflectStage;
  /** How the last run produced its suggestions: an LLM pass, or (builtin-local,
   *  which has no generative model) mechanical link-graph facts — see
   *  extractiveReflect. The panel labels extractive results so quoted facts
   *  are never mistaken for model judgment. */
  mode: "llm" | "extractive";
  /** The vault the last run read; a dismissal is remembered for it. */
  vault: string | null;
  /** The frontend opening that produced the current findings. */
  vaultToken: string | null;
  /** Native capability retained with findings until this opening is replaced. */
  origin: AgentVaultSession | null;
  /** Items from the last successful run, minus the ones acted on since. */
  suggestions: ReflectSuggestion[];
  /** How many the last run listed — the done line keeps saying it while
   *  acting on the findings empties the list. */
  found: number | null;
  /** Raw model output (or an error message when stage === "error"). */
  report: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** false after a run finishes until the user acknowledges the panel. */
  seen: boolean;
  /** True while createMissingPages is mid-loop. A new RUN during that loop
   *  would swap `suggestions` under it, leaving the progress UI and the
   *  loop's own cleanup pointing at a dead suggestion generation — so both
   *  entry points check this one flag instead of guarding per button. */
  applying: boolean;
  /** Suggestion keys the user told us to stop reporting (persisted). */
  ignored: Set<string>;
  /** Stop reporting these suggestions in this vault while their facts hold. */
  ignore: (items: ReflectSuggestion[]) => void;
  /** Take acted-on rows out of the list without remembering them: the next
   *  run reports them again if nothing changed. */
  drop: (items: ReflectSuggestion[]) => void;
  runReflect: (usage?: RoleUsage) => Promise<void>;
  /** Create the missing page for every unresolved-wikilink suggestion (or just
   *  the ones passed — the per-row button hands it one). Applied items leave
   *  the list; on the first failure it stops and leaves the rest listed. */
  createMissingPages: (
    items?: ReflectSuggestion[],
    onProgress?: (done: number, total: number) => void,
  ) => Promise<{ created: number; failed: string | null }>;
  markSeen: () => void;
  dismiss: () => void;
}

/** Stable identity for "I already dealt with this / do not tell me again".
 *  Orphan pages and dangling links are PERMANENT facts until the user acts,
 *  so without this every run re-reports the same items forever. */
export function suggestionKey(s: ReflectSuggestion): string {
  if (s.kind === "orphan") return `orphan:${s.page}`;
  if (s.kind === "unresolved") return `link:${s.link}`;
  return `text:${s.text}`;
}

const IGNORED_KEY = "myco.reflect.ignored.v1";
const MAX_IGNORED = 500; // bounded so localStorage cannot grow forever

/** A stored dismissal is per vault: the vault path, a newline, the key. One
 *  flat list, so the settings export carries it unchanged. Entries saved
 *  before dismissals were per vault are a bare key; no run can tell which
 *  vault they came from, so they keep holding everywhere. */
const scoped = (vault: string, key: string): string => `${vault}\n${key}`;

function isIgnored(ignored: ReadonlySet<string>, vault: string, s: ReflectSuggestion): boolean {
  const key = suggestionKey(s);
  return ignored.has(scoped(vault, key)) || ignored.has(key);
}

/** A dismissal lasts while its fact holds: drop this vault's link-graph
 *  dismissals the run no longer finds, so a fact that comes back later is
 *  news. Model prose (`text:`) is never found twice alike, so it stays. */
function forgetSettled(
  ignored: ReadonlySet<string>,
  vault: string,
  live: ReadonlySet<string>,
): Set<string> {
  const prefix = scoped(vault, "");
  return new Set(
    [...ignored].filter((e) => {
      if (!e.startsWith(prefix)) return true;
      const key = e.slice(prefix.length);
      return key.startsWith("text:") || live.has(key);
    }),
  );
}

export function loadIgnored(): Set<string> {
  try {
    const raw = localStorage.getItem(IGNORED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function saveIgnored(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(
      IGNORED_KEY,
      JSON.stringify([...keys].slice(-MAX_IGNORED)),
    );
  } catch {
    /* quota or disabled — dismissal just won't persist */
  }
}

let reflectSeq = 0;

function isCurrentVault(path: string, token: string): boolean {
  const state = useVaultStore.getState();
  return !state.isOpeningVault && state.currentVault?.path === path && state.vaultToken === token;
}

export const useReflectStore = create<ReflectState>((set, get) => ({
  stage: "idle",
  applying: false,
  ignored: loadIgnored(),
  mode: "llm",
  vault: null,
  vaultToken: null,
  origin: null,
  suggestions: [],
  found: null,
  report: null,
  startedAt: null,
  finishedAt: null,
  seen: true,

  async runReflect(usage = "foreground") {
    const { currentVault: vault, vaultToken, isOpeningVault } = useVaultStore.getState();
    // `applying`: a run mid-bulk-apply would replace `suggestions` under the
    // loop, stranding its progress UI and cleanup on a dead generation.
    if (!vault || isOpeningVault || get().stage === "running" || get().applying) return;
    const seq = ++reflectSeq;
    const isCurrent = () => seq === reflectSeq && isCurrentVault(vault.path, vaultToken);
    // builtin-local has no chat model to generate with (see chat.ts's
    // CHAT_MODEL_MISSING) — it used to flip the panel into "blocked" here.
    // It now reflects extractively instead (same move as sessionDigest's
    // extractive digest): the link graph already knows the mechanical
    // findings, no generation needed.
    // A new run replaces the last one's list from its first moment.
    set({
      stage: "running",
      vault: vault.path,
      vaultToken,
      origin: null,
      report: null,
      suggestions: [],
      found: null,
      startedAt: Date.now(),
      finishedAt: null,
      seen: true,
    });
    try {
      const origin = Object.freeze(await ipc.agentVaultSession());
      if (!isCurrent()) return;
      if (origin.vaultPath !== vault.path) {
        throw new Error("the active vault changed before reflect started");
      }
      set({ origin });
      const roleSnapshot = await ipc.captureModelRole(origin, "reflect", usage);
      const { providerId: provider, modelId: model } = roleSnapshot.routeSignature;
      if (!isCurrent()) return;
      const extractive = provider === "builtin-local" && !isBuiltinChatModel(model);
      set({ mode: extractive ? "extractive" : "llm" });
      let out: string;
      let suggestions: ReflectSuggestion[];
      // Dismissed findings are facts that hold until the user acts (an
      // orphan stays an orphan) — every run would re-report them.
      const ignored = get().ignored;
      const skip = (s: ReflectSuggestion): boolean => isIgnored(ignored, vault.path, s);
      if (extractive) {
        const found = await extractiveReflect(vault.path, skip, isCurrent);
        if (!isCurrent()) return;
        suggestions = found.suggestions;
        out = suggestions.map((s) => s.text).join("\n");
        const kept = forgetSettled(ignored, vault.path, found.live);
        if (kept.size !== ignored.size) {
          saveIgnored(kept);
          set({ ignored: kept });
        }
      } else {
        out = await complete({
          task: "generate", featureRole: "reflect", roleSnapshot, usage,
          cwd: vault.path,
          origin,
          messages: [{ role: "user", content: REFLECT_PROMPT }],
        });
        if (!isCurrent()) return;
        // Prose only: no kind, so the panel shows these without an action.
        suggestions = parseSuggestions(out)
          .map((text) => ({ text }))
          .filter((s) => !skip(s));
      }
      set({
        stage: "done",
        report: out || "(no output)",
        suggestions,
        found: suggestions.length,
        finishedAt: Date.now(),
        seen: false,
      });
    } catch (err) {
      if (!isCurrent()) return;
      set({
        stage: "error",
        // err is an Error thrown by complete()/the provider — String(err) on an
        // Error already yields "Error: <message>", so prefixing another "ERROR:"
        // doubled it. Use the bare message instead.
        report: err instanceof Error ? err.message : String(err),
        suggestions: [],
        finishedAt: Date.now(),
        seen: false,
      });
    }
  },

  async createMissingPages(items, onProgress) {
    // Native resolves or creates within the captured opening, including its
    // collision check; ordinary unscoped new-note actions cannot bind a run.
    const { vault, vaultToken, origin, suggestions, applying, stage } = get();
    if (!vault || !vaultToken || !origin || applying || stage !== "done" || !isCurrentVault(vault, vaultToken)) {
      return { created: 0, failed: null };
    }
    const seq = reflectSeq;
    const isCurrent = () => seq === reflectSeq && isCurrentVault(vault, vaultToken);
    // A queued click may carry a row replaced by a newer run in the same vault.
    const targets = (items ?? suggestions).filter((s) => suggestions.includes(s)).filter(isUnresolved);
    const applied = new Set<ReflectSuggestion>();
    let failed: string | null = null;
    // Held for the whole loop so runReflect (button OR scheduler tick) cannot
    // swap the suggestion array we are walking and filtering against.
    set({ applying: true });
    try {
      for (const s of targets) {
        if (!isCurrent()) break;
        let path: string | null = null;
        try {
          path = await ipc.reflectCreateMissingPage(origin, s.link);
        } catch {
          path = null;
        }
        if (!isCurrent()) break;
        if (!path) {
          failed = s.link;
          break; // stop on first error; the rest stay listed
        }
        applied.add(s);
        onProgress?.(applied.size, targets.length);
      }
      if (applied.size > 0 && isCurrent()) {
        set({ suggestions: get().suggestions.filter((s) => !applied.has(s)) });
        await useVaultStore.getState().refreshTree();
        if (isCurrent()) void useVaultStore.getState().refreshLinkGraph();
      }
    } finally {
      if (isCurrent()) set({ applying: false });
    }
    return { created: applied.size, failed };
  },

  ignore: (items) => {
    const vault = get().vault;
    if (!vault) return;
    const next = new Set(get().ignored);
    for (const s of items) next.add(scoped(vault, suggestionKey(s)));
    saveIgnored(next);
    set({
      ignored: next,
      suggestions: get().suggestions.filter((s) => !isIgnored(next, vault, s)),
    });
  },

  drop: (items) => set({ suggestions: get().suggestions.filter((s) => !items.includes(s)) }),

  markSeen: () => set({ seen: true }),

  dismiss: () => {
    reflectSeq++;
    set({
      stage: "idle",
      applying: false,
      mode: "llm",
      vault: null,
      vaultToken: null,
      origin: null,
      suggestions: [],
      found: null,
      report: null,
      startedAt: null,
      finishedAt: null,
      seen: true,
    });
  },
}));

// A path alone cannot identify an opening: reopening the same root also
// invalidates every pending result and every action on its old findings.
useVaultStore.subscribe((state, previous) => {
  if (state.vaultToken !== previous.vaultToken || state.currentVault?.path !== previous.currentVault?.path ||
      (state.isOpeningVault && !previous.isOpeningVault)) {
    useReflectStore.getState().dismiss();
  }
});

/** What the card says about the last run (spec 2026-10-02 #5). Idle and
 * running have no line: the run button says those itself, with a plain icon
 * or a spinner. Done names the time and the run's own count — frozen in
 * `found`, so working through the list does not rewrite it. */
export type ReflectStatus =
  | { tone: "idle" | "running" }
  | { tone: "done"; line: string }
  | { tone: "failed"; line: string; detail: string };

export function reflectStatus(
  s: Pick<ReflectState, "stage" | "found" | "finishedAt" | "report">,
  strings: Pick<Strings, "rf_done" | "rf_failed">,
  lang: string,
): ReflectStatus {
  if (s.stage === "error") return { tone: "failed", line: strings.rf_failed, detail: s.report ?? "" };
  if (s.stage !== "done") return { tone: s.stage };
  const time = new Intl.DateTimeFormat(lang, { timeStyle: "short" }).format(s.finishedAt ?? Date.now());
  return {
    tone: "done",
    line: strings.rf_done
      .replace("{time}", time)
      .replace("{n}", new Intl.NumberFormat(lang).format(s.found ?? 0)),
  };
}

/** The vault-relative path a row's title keeps (its text names only the
 *  note); undefined for model prose, which names no page we know. */
export function suggestionPath(s: ReflectSuggestion, vaultPath: string): string | undefined {
  if (s.kind === "orphan") return vaultRel(s.page, vaultPath);
  if (s.kind === "unresolved") return `${vaultRel(s.from, vaultPath)} → [[${s.link}]]`;
  return undefined;
}

/** Only the owner's notes are judged (spec 2026-10-02 #7): not the folders
 *  myco keeps (classifyTopLevel, the sidebar's own split), not its topic maps
 *  or the welcome page it seeds, and not the graph view's machine and
 *  structural pages (daily/, index, log…). */
export function isOwnNote(vaultPath: string, page: string): boolean {
  const rel = vaultRel(page, vaultPath);
  return (
    classifyTopLevel(rel.split("/")[0]) === "mine" &&
    !rel.startsWith("wiki/maps/") &&
    rel !== "welcome.md" &&
    !isNonKnowledgePath(vaultPath, page)
  );
}

/** A row's name for a note: its readable name, never its path. */
const noteName = (path: string): string => displayName(stem(path));

// Matches REFLECT_PROMPT's "at most 8 items".
const MAX_SUGGESTIONS = 8;

// Root-ish stems nothing is expected to link TO — flagging them as orphans
// would be the same noise on every run.
const ORPHAN_EXEMPT = new Set(["index", "home", "readme"]);

/** Extractive reflect for builtin-local (no generative model): the
 * REFLECT_PROMPT findings that are mechanical facts of the link graph —
 * orphan pages and unresolved [[wikilinks]] — read from ipc.buildLinkGraph.
 * Staleness and prose-mention cross-references need judgment over page
 * content, so they are honestly out of scope here. When the graph yields
 * more than MAX_SUGGESTIONS candidates, the bundled embedder plus
 * centroid+MMR (mmrSelect, shared with the session digest) picks a diverse
 * top 8 — deterministic given the same vault, like the extractive digest.
 *
 * Two things the first version got wrong, both measured on the real vault
 * (180 .md → 19 candidates, only ONE of them actionable):
 *
 *  - It read orphan candidacy off `graph.forward`'s KEYS. Rust only records a
 *    key for a page with at least one RESOLVED outgoing link, so the pages
 *    with no links at all — the most orphaned pages there are, 81 of them —
 *    were the ones it could never see. Candidacy now comes from the vault's
 *    markdown files (flattenMarkdown, the same source the graph view uses for
 *    orphan nodes), unioned with the graph keys in case the tree isn't loaded.
 *  - It applied no knowledge filter, so ingest-reports/, daily/ (five
 *    identical `[[TASK_DONE]]` ghosts) and wiki/log.md crowded out the real
 *    findings — 12 of the 19. isNonKnowledgePath is the graph view's own
 *    filter for exactly this, imported rather than restated; isOwnNote adds
 *    the folders myco keeps (work/, audio/ …), its maps and welcome.md.
 *
 * `skip` names dismissed findings; `live` comes back with every finding that
 * holds now, dismissed or not. */
export async function extractiveReflect(
  vaultPath: string,
  skip: (s: ReflectSuggestion) => boolean = () => false,
  isCurrent: () => boolean = () => true,
): Promise<{ suggestions: ReflectSuggestion[]; live: Set<string> }> {
  const tree = useVaultStore.getState().fileTree;
  if (!isCurrent()) throw new Error("the vault opening changed before reflect started");
  const graph = await ipc.buildLinkGraph(vaultPath);
  if (!isCurrent()) throw new Error("the vault opening changed during reflect");
  const pages = new Set([
    ...flattenMarkdown(tree),
    ...Object.keys(graph.forward),
  ]);
  const candidates: ReflectSuggestion[] = [];
  for (const page of [...pages].sort()) {
    if (!isOwnNote(vaultPath, page)) continue;
    if (ORPHAN_EXEMPT.has(stem(page).toLowerCase())) continue;
    if ((graph.backward[page] ?? []).length === 0) {
      candidates.push({
        text: t().rf_item_orphan.replace("{page}", noteName(page)),
        kind: "orphan",
        page,
      });
    }
  }
  for (const page of Object.keys(graph.unresolved).sort()) {
    if (!isOwnNote(vaultPath, page)) continue;
    for (const target of [...graph.unresolved[page]].sort()) {
      // A template placeholder ("source-<slug>") or dots-only name is not a
      // page anyone can create — the gap panel already buckets those away
      // from real missing pages, and reflect must not offer them either.
      if (isMalformedLinkName(target)) continue;
      candidates.push({
        text: t()
          .rf_item_unresolved.replace("{page}", noteName(page))
          .replace("{target}", displayName(target)),
        kind: "unresolved",
        link: target,
        from: page,
      });
    }
  }
  // `live` is every finding that holds now, dismissed or not — what tells a
  // dismissal its fact is gone. Dismissed ones leave BEFORE the pick: MMR is
  // deterministic, so filtering after it would re-pick the same dismissed 8
  // and hide the rest for good.
  const live = new Set(candidates.map(suggestionKey));
  const open = candidates.filter((c) => !skip(c));
  if (open.length <= MAX_SUGGESTIONS) return { suggestions: open, live };
  const vectors = await ipc.embedLocalTexts(open.map((c) => c.text));
  if (!isCurrent()) throw new Error("the vault opening changed during reflect");
  return { suggestions: mmrSelect(vectors, MAX_SUGGESTIONS).map((i) => open[i]), live };
}

// Extract bullet items from the model's markdown. Accepts "-", "*", "•" and
// numbered ("1.", "1)") markers; falls back to non-empty lines if nothing
// matched so a run never silently yields an empty list from valid prose.
export function parseSuggestions(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const bullets = lines
    .map((l) => {
      const m = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      return m ? m[1].trim() : null;
    })
    .filter((l): l is string => !!l);
  if (bullets.length > 0) return bullets;
  return lines.map((l) => l.trim()).filter((l) => l.length > 0);
}
