// Ask chat state, lifted out of PageQuery so an in-flight answer survives
// navigating to other pages (same pattern as lintStore/ingestStore). The
// Topbar shows a chip while an answer runs and after it finishes until the
// user revisits the Query page.

import { create } from "zustand";
import { complete, retrieveChunks, type AskStage } from "../lib/chat";
import { formatExtractiveAnswer, groupByPage, quoteBody } from "../lib/extractive";
import { chunkCitation } from "../lib/retrievalContext";
import { nearMissesOf, shouldAbstain } from "../lib/abstention";
import { traceOf, type RetrievalTrace } from "../lib/ladder";
import { ipc, type ActivitySynthesisReceipt, type AgentVaultSession, type AskRecord, type AskScope, type NearMiss, type ScoredChunk } from "../lib/ipc";
import { extractWikilinks } from "../lib/askHistory";
import {
  formatActivityAnswer,
  formatRecentFilesAnswer,
  isActivityQuery,
  isRepositoryHistoryQuery,
  isVaultFilesQuery,
} from "../lib/queryIntent";
import { isBuiltinChatModel, BUILTIN_EMBED_MODEL, BUILTIN_MODEL } from "../lib/providers";
import { log } from "../lib/log";
import { parseTimeQuery, type DateRange } from "../lib/timeQuery";
import { followUpContext, plainPassage } from "../lib/askLoop";
import type { Captured } from "../lib/dailyNote";
import { noteScopePaths, type NoteScope } from "../lib/noteScope";

/** Mirrors `intent::VAULT_FILES` on the Rust side. */
const VAULT_FILES_INTENT = "vault-files";
import type { Lang, Strings } from "../lib/i18n";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";
import HEADS from "../lib/mycoPromptHeads.json";
import { isActivityOverviewQuery, isMemoryQuestion, recallPolicy } from "../lib/recallPolicy";
import { formatTemporalRecall } from "../lib/queryTemporal";
import { connectionOverview, connectionScopeNotice, isConnectionOverviewQuery } from "../lib/queryConnections";
import { ActivitySynthesisError, LocalSynthesisError, LocalSynthesisSourceError, isSynthesisReviewFailure, tryLocalSynthesis, type ActivitySynthesisFailure, type LocalSynthesisFallbackReason } from "../lib/querySynthesis";
import { isNextWorkOverview, isUndatedActivityOverview, retrieveActivity } from "../lib/queryActivity";
import { activityResolution } from "../lib/queryResolution";
import { checkedAskRole, isQueryAuthorizationError, QueryAuthorizationError } from "../lib/queryRole";
import type { RoleSnapshot } from "../lib/modelRoles";
import { useSettingsStore } from "./settingsStore";

/** Top-k the extractive path retrieves — also the stepper's "cap" step. */
const RETRIEVE_K = 12;
/** Pages an extractive answer quotes (formatExtractiveAnswer's default). */
export const QUOTED_PAGES = 5;
/** Turns the history keeps — `ask_history::CAP`. */
const HISTORY_CAP = 500;

export interface ChatTurn {
  q: string;
  a: string;
  error?: string;
  /// The embedding index predated a bundled embed-model swap, so this answer
  /// used the whole-vault fallback instead of semantic retrieval — surfaced
  /// so the fallback stays visible instead of a silent quality drop.
  stale?: boolean;
  /// An IPC call inside retrieval (embeddings_status/semantic_search)
  /// actually rejected, so this answer used the whole-vault fallback instead
  /// — distinct from a legitimately empty index/hit list, which is not a
  /// failure and must not set this.
  retrievalFailed?: boolean;
  /// Answer is retrieved passages rendered verbatim, without generation.
  extractive?: boolean;
  /** Selected local artifact used for synthesis; not a semantic quality claim. */
  localModel?: string;
  /** Coverage of date-grounded activity evidence, kept out of answer history. */
  activityCoverage?: { scannedPages: number; sources: number; incomplete: boolean };
  activityReceipt?: ActivitySynthesisReceipt;
  activityFailure?: ActivitySynthesisFailure;
  /** Static reason the selected local generator could not produce a verified answer. */
  localFallback?: LocalSynthesisFallbackReason;
  /// Extractive turn that produced no passages (stale index, retrieval
  /// failure, or a legitimately empty hit list) — suppresses the "From your
  /// notes" label, since there is nothing to attribute to the notes.
  extractiveEmpty?: boolean;
  /// The hits retrieval kept (above the floor), in the backend's ranked
  /// order. The page builds the answer body, the source ladder and the
  /// coverage row from these — and re-ranks them live as the tier sliders
  /// move, which is why the raw hits stay on the turn (top-k, small). Only
  /// the extractive path has them: a provider-synthesized answer cites pages
  /// in prose, with no per-citation numbers to report. NEVER mixed into `a`:
  /// prior turns are re-sent verbatim as provider history, so metadata in
  /// the answer text would leak into the next question's prompt.
  hits?: ScoredChunk[];
  /// What the retrieval stepper can say about this turn.
  trace?: RetrievalTrace;
  /// The dense-cosine floor the hits were judged against.
  floor?: number;
  /// No hit cleared the floor: the page renders the abstention card, never
  /// a quoted passage. `nearMisses` are the closest rejects (≤4).
  abstained?: boolean;
  nearMisses?: NearMiss[];
  /** A capability or scope limit, distinct from a claim of missing notes. */
  abstainExplanation?: string;
  /// The question was logged to the recall-miss log — by the abstain card's
  /// "make this a harvest target" or an answer's "not what you expected" —
  /// once; both buttons read as done.
  harvested?: boolean;
  /// The abstain card wrote the question into today's note — set at the
  /// press, so the button reads as done and never writes twice.
  noted?: boolean;
  /// What capture_note wrote it as, once it returned: the card's done
  /// button opens that note on that line.
  notedIn?: Captured;
  /// Search scope the question ran with — shown as a chip beside it.
  scope?: AskScope;
  /// "Ask this note" (UX S37): the question ran over this note and its
  /// one-hop links only; the chip names the note instead of the scope.
  note?: NoteScope;
  /// Asked without the period its words name ("search again without the
  /// period"): a retry of the turn drops it too.
  ignoreRange?: boolean;
  /// Stopped (■) before the answer came back: the turn stays as a 멈춤 card,
  /// and the answer that arrives late is dropped.
  stopped?: boolean;
  /// Date window parsed from the question (time-aware Ask, Q4 item 8) —
  /// retrieval was restricted to that window's dated tiers; the UI shows it
  /// as a chip beside the question.
  range?: DateRange;
  /// A short or pronoun-led question ("그건 왜 중요해?") retrieved with the
  /// previous turn's question prepended — shown as a chip, and an abstention
  /// on it is not offered as a harvest target (the gap is the pronoun's).
  followUp?: boolean;
}

export const SYSTEM_PREAMBLE = `${HEADS.ask}
The current working directory is the vault root. Use Read/Grep/Glob tools to
look up answers from the wiki (\`wiki/\` if it exists) before reaching for
\`raw/\` sources. Answer in the user's language. When you state a fact that
comes from a vault file, cite it inline as [[vault-relative/path|page-stem]].
Keep the source date with historical claims. Report conflicting evidence;
an old decision or a proposed change does not establish the current state.`;

/** Localized copy ask() bakes into turns. Passed per call from the page's `t`
 * so the store itself stays i18n-free (stores outlive language switches). */
export interface AskCopy {
  extractiveStale: string;
  extractiveFailed: string;
  extractiveEmpty: string;
  sourceChanged: string;
  modelSelectionChanged: string;
  activityFailed: string;
  activitySummaryFailed: string;
  activityIncomplete: string;
  answerReviewFailed: string;
  activityInsufficientEvidence: string;
  /// Extractive empty copy while a date range is active — "nothing in that
  /// period's record" is a different fact than "nothing relevant anywhere".
  rangeEmpty: string;
  emptyResponse: string;
}

/** The AskCopy every caller of `ask()` passes, in one place — the Ask page and
 * the global-shortcut spotlight must bake identical copy into a turn, and two
 * copies of these fallbacks would drift. */
export function askCopy(t: Strings): AskCopy {
  return {
    extractiveStale:
      t.q_extractive_stale ??
      "The semantic index predates a model update, and keyword search found no verified passages. Run “Reindex now” under Model settings, then ask again.",
    extractiveFailed:
      t.q_extractive_failed ??
      "The search index could not be reached, so no passages could be retrieved. If it keeps happening, run “Reindex now” under Model settings.",
    extractiveEmpty:
      t.q_extractive_empty ?? "Nothing relevant found in the wiki index.",
    sourceChanged: t.q_source_changed,
    modelSelectionChanged: t.q_model_selection_changed,
    activityFailed: t.q_activity_failed,
    activitySummaryFailed: t.q_activity_summary_failed,
    activityIncomplete: t.q_activity_incomplete,
    answerReviewFailed: t.q_answer_review_failed,
    activityInsufficientEvidence: t.q_activity_insufficient_evidence,
    rangeEmpty:
      t.q_range_empty ?? "No answer found in the records for that period.",
    emptyResponse: t.q_empty_response ?? "(empty response)",
  };
}

export interface AskOpts {
  scope?: AskScope;
  /** Captured period for retry or scope widening; ignoreRange still takes precedence. */
  range?: DateRange;
  /** "Search again without the period": retrieve with the question's words
   *  but no date window, though it still names one. */
  ignoreRange?: boolean;
  /** "Ask this note": only this note and its one-hop links, over every tier.
   *  Only the Ask page's composer passes it — a question asked elsewhere
   *  (Spotlight, Home) is never narrowed by a scope the page shows. */
  note?: NoteScope;
}

/** The abstain card's two re-asks of `turn`, each absent where there is
 *  nothing to do. `widen` searches every scope and keeps the turn's period —
 *  including none: a turn without a range either never named one (then
 *  `ignoreRange` is a no-op) or had it dropped, and `q` still says "last
 *  week", so without the flag ask() would parse the window straight back.
 *  `dropRange` searches the turn's own scope without its period. */
export function reasksOf(turn: ChatTurn): { widen?: AskOpts; dropRange?: AskOpts } {
  // A note's turn widens out of the note into every scope.
  return {
    widen:
      turn.scope === "all" && !turn.note ? undefined : { scope: "all", ignoreRange: !turn.range,
        ...(turn.range ? { range: turn.range } : {}) },
    dropRange: turn.range
      ? { scope: turn.scope, ignoreRange: true, ...(turn.note ? { note: turn.note } : {}) }
      : undefined,
  };
}

/** `turn` as the history log keeps it: what the page showed, not the hits
 *  behind it. An extractive answer is its quoted pages, each passage plain
 *  as the page draws it (no `# H1`, no `[^n]`) under its [[stem]]; the notes
 *  cited are those pages, else the [[links]] in the answer. */
export function recordOf(turn: ChatTurn, at: number): AskRecord {
  const quoted = turn.hits && !turn.localModel ? groupByPage(turn.hits, QUOTED_PAGES) : null;
  const a = quoted
    ? quoted
        .map((g) => {
          const lines = plainPassage(quoteBody(g.texts)).split("\n");
          return `**${chunkCitation(g)}**\n\n${lines.map((l) => `> ${l}`).join("\n")}`;
        })
        .join("\n\n")
    : turn.a;
  return {
    at,
    q: turn.q,
    // A note's turn ran over the note, not over its "all" scope.
    ...(turn.note
      ? { note: { title: turn.note.title } }
      : turn.scope
        ? { scope: turn.scope }
        : {}),
    // An abstained turn shows the card, never its fallback text.
    a: turn.abstained ? "" : a,
    cited: quoted ? quoted.map((g) => g.stem) : extractWikilinks(turn.a),
    ...(turn.abstained ? { abstained: true } : {}),
    ...(turn.stopped ? { stopped: true } : {}),
    ...(turn.error ? { error: turn.error } : {}),
  };
}

interface QueryState {
  turns: ChatTurn[];
  /** This device's past turns for the open vault, oldest first (UX S36). */
  history: AskRecord[];
  /** The history log could not be read: the list says so. */
  historyError: string | null;
  busy: boolean;
  stage: AskStage | null;
  /** Monotonic renderer clock for the active Ask, never a persisted date. */
  startedAt: number | null;
  /** false after an answer lands until the user revisits the Query page. */
  seen: boolean;
  /** The note the Ask composer is scoped to ("Ask this note", UX S37), until
   *  the user clears its chip. The page passes it to ask(). */
  noteScope: NoteScope | null;
  setNoteScope: (note: NoteScope | null) => void;
  /** `opts.scope` runs this one question over that scope ("widen") without
   *  touching the saved scope segment; absent, the saved scope applies.
   *  `opts.ignoreRange` drops the question's date window. Resolves with the
   *  turn this question ended as — answered, failed or stopped — and at once
   *  on ■; undefined when it did not run (empty, no vault, another running). */
  ask: (
    question: string,
    lang: Lang,
    copy: AskCopy,
    opts?: AskOpts,
  ) => Promise<ChatTurn | undefined>;
  /** The last turn's [다시 시도], when it failed: drop it and ask its
   *  question again with its scope (and its dropped period), so the answer
   *  lands in its place with the same turns before it. Nothing for an
   *  earlier turn (later questions would become its context and it would
   *  land below them), a turn that did not fail, or while another runs. */
  retry: (i: number, lang: Lang, copy: AskCopy) => Promise<void>;
  /** ■: stop the running question. Its turn becomes 멈춤 at once, the
   *  composer is free and its ask() settles with that turn; the provider call
   *  already in flight may still finish in the background, and what it
   *  returns is dropped. */
  stop: () => void;
  /** Log turn `i`'s question as a recall miss (the harvest queue reads that
   *  log) and mark the turn so the button reads as done. Rejects when the
   *  write fails, leaving the turn unmarked for a retry. */
  harvest: (i: number) => Promise<void>;
  /** Write turn `i`'s question down with `write` (which resolves whether it
   *  wrote), once: the turn is marked at the press, and unmarked again only
   *  when the write failed. */
  note: (i: number, write: (q: string) => Promise<Captured | null>) => Promise<void>;
  markSeen: () => void;
  /** Read the open vault's history log (the Ask page, per vault). */
  loadHistory: () => Promise<void>;
  clear: () => void;
}

/** The run ■ stops (agentStore's AbortController pattern): aborting it marks
 *  its turn 멈춤 and settles its ask(). */
let running: AbortController | null = null;
let conversationRevision = 0;
let vaultRevision = 0;
let historyRequest = 0;
const pendingRecallWrites = new Set<symbol>();
const turnIdentities = new WeakMap<ChatTurn, symbol>();

function turnIdentity(turn: ChatTurn): symbol {
  let identity = turnIdentities.get(turn);
  if (!identity) {
    identity = Symbol();
    turnIdentities.set(turn, identity);
  }
  return identity;
}

/** Preserve logical identity when independent actions patch the same turn. */
function patchTurn(turn: ChatTurn, patch: Partial<ChatTurn>): ChatTurn {
  const next = { ...turn, ...patch };
  turnIdentities.set(next, turnIdentity(turn));
  return next;
}

/** Rejects once `signal` aborts (■). */
function stopped(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const stop = (): void => reject(new Error("stopped"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** `turns` with the last one patched: where a run's outcome lands. */
function patchLast(turns: ChatTurn[], patch: Partial<ChatTurn>): ChatTurn[] {
  return turns.map((turn, i) => (i === turns.length - 1 ? patchTurn(turn, patch) : turn));
}

/** Append a finished turn to `vault`'s history log, then to the list. A failed
 *  write is logged and leaves the list as the log has it. */
function remember(vault: string, turn: ChatTurn, revision: number): void {
  const rec = recordOf(turn, Date.now());
  ipc.askHistoryAppend(vault, rec).then(
    () => {
      if (revision !== vaultRevision || useVaultStore.getState().currentVault?.path !== vault) return;
      useQueryStore.setState((s) => ({ history: [...s.history, rec].slice(-HISTORY_CAP) }));
    },
    () => log.warn("query.history_append_failed"),
  );
}

/** The answer for a question whose intent is NOT page content, or `null` when
 * the question is an ordinary content question after all (so the caller shows
 * its "nothing found" copy). Never throws: a classification or mtime failure
 * just means no meta answer, which the caller already handles. */
async function metaAnswer(
  question: string,
  vaultPath: string,
  lang: Lang,
  signal: AbortSignal,
  scope: AskScope,
  range?: DateRange,
): Promise<string | null> {
  if (!isVaultFilesQuery(question) || isRepositoryHistoryQuery(question)) return null;
  try {
    const verdict = await ipc.classifyIntent(
      question,
      "builtin-local",
      BUILTIN_EMBED_MODEL,
    );
    if (signal.aborted || verdict?.intent !== VAULT_FILES_INTENT) return null;
    const entries = await ipc.fileMtimes(vaultPath);
    return formatRecentFilesAnswer(entries, lang, Date.now(), 15, {
      vaultRoot: vaultPath,
      scope,
      range,
    });
  } catch {
    log.warn("query.intent_classify_failed");
    return null;
  }
}

export const useQueryStore = create<QueryState>((set, get) => ({
  turns: [],
  history: [],
  historyError: null,
  busy: false,
  stage: null,
  startedAt: null,
  seen: true,
  noteScope: null,
  setNoteScope: (noteScope) => set({ noteScope }),

  async ask(question, lang, copy, opts) {
    const snapshot = useVaultStore.getState();
    const vault = snapshot.currentVault;
    if (!question.trim() || !vault || get().busy || snapshot.isOpeningVault) return undefined;
    const startedAt = performance.now();
    const queryTime = new Date();
    const ctrl = new AbortController();
    running = ctrl;
    const revision = conversationRevision;
    const sourceVaultRevision = vaultRevision;
    let roleSnapshot: RoleSnapshot | undefined;
    let authorityRevoked = false;
    let unsubscribeSettings: (() => void) | undefined;
    const ownsState = (): boolean => revision === conversationRevision &&
      useVaultStore.getState().currentVault?.path === vault.path &&
      useVaultStore.getState().vaultToken === snapshot.vaultToken && !useVaultStore.getState().isOpeningVault;
    // What ask() resolves with: this question's turn as it ended.
    let outcome: ChatTurn | undefined;
    const end = (patch: Partial<ChatTurn>, rest: Partial<QueryState>): void => {
      if (!ownsState()) return;
      set((s) => ({ turns: patchLast(s.turns, patch), ...rest }));
      outcome = get().turns.at(-1);
      if (outcome) remember(vault.path, outcome, sourceVaultRevision);
    };
    // Once stopped, this run writes nothing: its late outcome would land on
    // the next question's turn, and its `finally` would free that one's busy.
    const live = (): boolean => ownsState() && !ctrl.signal.aborted;
    const finishTurn = (patch: Partial<ChatTurn>): void => {
      if (live()) end(patch, { seen: false });
    };
    // ■ (stop()): the turn becomes 멈춤 at once and the composer is free.
    ctrl.signal.addEventListener(
      "abort",
      () => end({ stopped: true, ...(authorityRevoked ? { a: "", error: copy.modelSelectionChanged } : {}) },
        { busy: false, stage: null, startedAt: null }),
      { once: true },
    );
    const settle = (): void => {
      unsubscribeSettings?.();
      unsubscribeSettings = undefined;
      if (running === ctrl) running = null;
      if (live()) set({ busy: false, stage: null, startedAt: null });
    };
    // The Ask page's scope segment and 고급 sliders, persisted per device.
    const { askScope, askTierWeights, isAskScopeExplicit } = useUIStore.getState();
    // Resolve at question time so routing and shortcuts use the same period.
    const tp = parseTimeQuery(question, queryTime, lang);
    if (opts?.range) tp.range = opts.range;
    const text = tp.range ? tp.cleaned : question;
    const isDatedActivityOverview = Boolean(tp.range && isActivityOverviewQuery(text));
    if (opts?.ignoreRange) tp.range = null;
    const note = opts?.note;
    // Over one note the path set decides, so no tier is cut out of it.
    const explicitScope = opts?.scope ?? (isAskScopeExplicit ? askScope : undefined);
    const { scope, tierWeights } = recallPolicy(question, askScope, askTierWeights, note ? "all" : explicitScope, isDatedActivityOverview);
    const paths = note ? noteScopePaths(note.path, vault.path, useVaultStore.getState().adjacency) : undefined;
    // The question this one may lean on (UX audit A2): "그건 왜 중요해?"
    // alone retrieves nothing its pronoun points at.
    const context = followUpContext(
      get().turns,
      question,
      (q) => parseTimeQuery(q, queryTime, lang).cleaned,
    );
    const followUp = context !== null;
    set((s) => ({
      turns: [
        ...s.turns,
        {
          q: question,
          a: "",
          scope,
          ...(note ? { note } : {}),
          ...(opts?.ignoreRange ? { ignoreRange: true } : {}),
        },
      ],
      busy: true,
      startedAt,
      seen: true,
    }));

    // The unrestricted recent git log cannot answer a date-restricted request,
    // a transcript-only scope, or a question over one note.
    if (!paths && !tp.range && scope !== "sessions" && !isMemoryQuestion(question) && isActivityQuery(question)) {
      try {
        const commits = await Promise.race([stopped(ctrl.signal), ipc.gitLog(vault.path, 20)]);
        finishTurn({ a: formatActivityAnswer(commits, lang) });
      } catch (error) {
        finishTurn({ a: "", error: String(error) });
      } finally {
        settle();
      }
      return outcome;
    }

    // One native-issued selection governs the entire question. Connection and
    // legacy global provider fields are not execution consent.
    let provider: string;
    let queryModel: string;
    let origin: AgentVaultSession;
    try {
      const settingsAtAdmission = useSettingsStore.getState();
      if (settingsAtAdmission.saving) throw new QueryAuthorizationError();
      unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
        const currentRevision = state.settings?.role_authorization_revision;
        const observedRevision = roleSnapshot?.authorizationRevision ??
          settingsAtAdmission.settings?.role_authorization_revision;
        if ((state.saving && !previous.saving) ||
            (currentRevision && observedRevision && currentRevision !== observedRevision)) {
          authorityRevoked = true;
          ctrl.abort();
        }
      });
      origin = await Promise.race([stopped(ctrl.signal), ipc.agentVaultSession()]);
      if (!live()) { settle(); return outcome; }
      if (!origin || origin.vaultPath !== vault.path || !origin.openingToken) throw new QueryAuthorizationError();
      roleSnapshot = checkedAskRole(origin,
        await Promise.race([stopped(ctrl.signal), ipc.captureModelRole(origin, "ask", "foreground")]), vault.path);
      const currentSettings = useSettingsStore.getState();
      if (currentSettings.saving || (currentSettings.settings?.role_authorization_revision &&
          currentSettings.settings.role_authorization_revision !== roleSnapshot.authorizationRevision))
        throw new QueryAuthorizationError();
      provider = roleSnapshot.routeSignature.providerId;
      queryModel = roleSnapshot.routeSignature.modelId;
    } catch (error) {
      finishTurn({ a: "", error: isQueryAuthorizationError(error) ? copy.modelSelectionChanged : String(error) });
      settle();
      return outcome;
    }
    if (!live()) { settle(); return outcome; }

    // Explicit extractive Ask quotes retrieved evidence. A selected generator
    // must produce a reviewed answer or retain an error outcome.
    if (provider === "builtin-local") {
      let localFallback: LocalSynthesisFallbackReason | undefined;
      let activityFailureCopy = copy.activityFailed;
      const isActivityRecall = isBuiltinChatModel(queryModel) && !opts?.ignoreRange &&
        (isDatedActivityOverview || isUndatedActivityOverview(question, lang, queryTime) || isNextWorkOverview(question));
      try {
        if (queryModel !== BUILTIN_MODEL && !isBuiltinChatModel(queryModel))
          throw new LocalSynthesisError("model_unavailable");
        if (isActivityRecall) {
          const activity = await retrieveActivity({
            question, lang, modelId: queryModel, expectedVault: vault.path, origin, roleSnapshot, queryTime, scope,
            range: tp.range ?? undefined, paths, signal: ctrl.signal,
            onThinking: () => { if (live()) set({ stage: { kind: "thinking", stems: [] } }); },
            onRangeSelected: (range) => {
              if (!live()) return;
              tp.range = range;
              set((s) => ({ turns: patchLast(s.turns, { range }) }));
            },
            onRetrieving: () => { if (live()) set({ stage: { kind: "retrieving" } }); },
          });
          if (!live()) return outcome;
          set((s) => ({ turns: patchLast(s.turns, { range: activity.range }) }));
          const coverage = { scannedPages: activity.scanned_pages, sources: 0, incomplete: activity.incomplete };
          if (!activity.hits.length) {
            finishTurn({ a: activity.incomplete ? "" : copy.rangeEmpty,
              ...(activity.incomplete ? { error: copy.activityIncomplete } : {}),
              range: activity.range, activityCoverage: coverage,
              activityFailure: "activity_insufficient_evidence" });
            return outcome;
          }
          activityFailureCopy = copy.activitySummaryFailed;
          const synthesis = await Promise.race([stopped(ctrl.signal), tryLocalSynthesis({
            question, lang, hits: activity.hits, expectedVault: vault.path, origin, roleSnapshot, scope, modelId: queryModel,
            range: activity.range, paths, signal: ctrl.signal, activityOverview: true,
            resolution: activityResolution(activity.range, queryTime, isNextWorkOverview(question) ? "current_state" : "historical_as_of"),
            onThinking: (stems) => { if (live()) set({ stage: { kind: "thinking", stems } }); },
            onFallback: (reason) => { if (live()) localFallback = reason; },
          })]);
          if (!synthesis) throw new Error("activity synthesis did not produce a verified answer");
          finishTurn({ a: synthesis.answer, localModel: synthesis.model_id, extractive: false,
            activityReceipt: synthesis.activity_receipt,
            range: activity.range, activityCoverage: { ...coverage, sources: synthesis.used_sources.length,
              incomplete: coverage.incomplete || Boolean(synthesis.activity_receipt?.originalInputsIncomplete || synthesis.activity_receipt?.omittedWindows || synthesis.activity_receipt?.omittedClaims ||
                synthesis.activity_receipt?.resolutionCoverage?.incomplete) ||
                synthesis.used_sources.length < new Set(activity.hits.map(hit => hit.page)).size } });
          return outcome;
        }
        // Generic discovery needs graph evidence. A transcript that repeats
        // the question in a test plan does not establish note connections.
        if (scope === "sessions" && isConnectionOverviewQuery(text)) {
          const notice = connectionScopeNotice(lang);
          finishTurn({ a: notice, abstained: true, abstainExplanation: notice,
            range: tp.range ?? undefined });
          return outcome;
        }
        // Topic-free activity recall asks for dated records, not similarity to
        // generic words like "things I did". Keep the speaker and source time.
        if (tp.range && isActivityOverviewQuery(text)) {
          if (live()) set({ stage: { kind: "retrieving" } });
          const events = await Promise.race([stopped(ctrl.signal), ipc.temporalRecall(tp.range, scope, paths)]);
          finishTurn({ a: formatTemporalRecall(events, tp.range, lang), range: tp.range });
          return outcome;
        }
        if (!tp.range && scope !== "sessions" && isConnectionOverviewQuery(question)) {
          if (live()) set({ stage: { kind: "retrieving" } });
          const adjacency = useVaultStore.getState().adjacency ??
            await Promise.race([stopped(ctrl.signal), ipc.buildLinkGraph(vault.path)]);
          if (!live()) return outcome;
          const overview = connectionOverview(question, adjacency, { root: vault.path, scope, lang, paths });
          if (overview) {
            finishTurn({ a: overview });
            return outcome;
          }
        }
        // The callback fires just before the actual hybrid search IPC.
        // Missing dense vectors still allow the independent lexical search.
        const r = await Promise.race([stopped(ctrl.signal), retrieveChunks(
          context ? `${context} ${text}` : text,
          RETRIEVE_K,
          () => {
            if (live()) set({ stage: { kind: "retrieving" } });
          },
          tp.range ?? undefined,
          scope,
          tierWeights,
          paths,
        )]);
        const ran = !r.stale && !r.retrievalFailed;
        if (!ran && isBuiltinChatModel(queryModel))
          throw new LocalSynthesisError(r.stale ? "index_stale" : "retrieval_failed");
        // Exact source matches and dense relevance share the grounding rule.
        const abstained = ran && shouldAbstain(r.hits, r.floor);
        const md = abstained ? "" : formatExtractiveAnswer(r.hits);
        if (md && ran && isBuiltinChatModel(queryModel)) {
          if (live()) set({ stage: null });
          const synthesis = await Promise.race([stopped(ctrl.signal), tryLocalSynthesis({
            question, lang, hits: r.hits, expectedVault: vault.path, origin, roleSnapshot, scope, modelId: queryModel,
            previousQuestion: context ?? undefined,
            range: tp.range ?? undefined, paths, signal: ctrl.signal,
            onThinking: (stems) => {
              if (live()) set({ stage: { kind: "thinking", stems } });
            },
            onFallback: (reason) => { if (live()) localFallback = reason; },
          })]);
          if (!synthesis) throw new LocalSynthesisError("response_rejected");
          finishTurn({ a: synthesis.answer, localModel: synthesis.model_id, extractive: false,
            hits: r.hits, trace: traceOf(r, r.indexedPages, RETRIEVE_K), floor: r.floor,
            range: tp.range ?? undefined, followUp: followUp || undefined });
          return outcome;
        }
        // Pick the body by state: a stale/failed index means retrieval never
        // ran, so those get their own honest copy instead of the generic
        // "found nothing" message (which implies retrieval ran and came up
        // empty).
        // Only explicit file activity can be answered from modification times.
        // A classifier guess cannot replace missing personal-history evidence.
        // Over one note, a vault-wide file list is outside the requested scope.
        if (!md && ran && !paths && isVaultFilesQuery(question)) {
          const meta = await Promise.race([stopped(ctrl.signal), metaAnswer(question, vault.path, lang, ctrl.signal, scope, tp.range ?? undefined)]);
          if (meta) {
            finishTurn({ a: meta, range: tp.range ?? undefined });
            return outcome;
          }
        }
        const body = r.stale
          ? copy.extractiveStale
          : r.retrievalFailed
            ? copy.extractiveFailed
            : md || (tp.range ? copy.rangeEmpty : copy.extractiveEmpty);
        finishTurn({
          a: body,
          extractive: true,
          extractiveEmpty: !md,
          localFallback: md ? localFallback : undefined,
          // r.hits is alive only in this scope — the page's ladder, answer
          // body and coverage row all derive from it later.
          hits: md ? r.hits : undefined,
          trace: ran ? traceOf(r, r.indexedPages, RETRIEVE_K) : undefined,
          floor: r.floor,
          abstained: abstained || undefined,
          nearMisses: abstained ? nearMissesOf(r.hits, r.nearMisses) : undefined,
          stale: r.stale,
          retrievalFailed: r.retrievalFailed,
          range: tp.range ?? undefined,
          followUp: followUp || undefined,
        });
      } catch (err) {
        if (isActivityRecall && live()) log.warn("query.activity_failed");
        finishTurn({ a: "", ...(tp.range ? { range: tp.range } : {}), ...(isActivityRecall ? { localFallback } : {}),
          ...(err instanceof ActivitySynthesisError || err instanceof LocalSynthesisError ? { activityFailure: err.code } : {}),
          ...(err instanceof LocalSynthesisError && err.code === "index_stale" ? { stale: true } : {}),
          ...(err instanceof LocalSynthesisError && err.code === "retrieval_failed" ? { retrievalFailed: true } : {}),
          error: isQueryAuthorizationError(err) ? copy.modelSelectionChanged :
            err instanceof LocalSynthesisSourceError ? copy.sourceChanged :
            err instanceof LocalSynthesisError && err.code === "index_stale" ? copy.extractiveStale :
            err instanceof LocalSynthesisError && err.code === "retrieval_failed" ? copy.extractiveFailed :
            err instanceof LocalSynthesisError ? copy.answerReviewFailed :
            err instanceof ActivitySynthesisError && isSynthesisReviewFailure(err.code) ? copy.answerReviewFailed :
            err instanceof ActivitySynthesisError && err.code === "activity_insufficient_evidence" ? copy.activityInsufficientEvidence :
            isActivityRecall ? activityFailureCopy : String(err) });
      } finally {
        settle();
      }
      return outcome;
    }

    // Set from the `thinking` stage if the index turned out stale or
    // retrieval itself failed — read once the run finishes, since the
    // `finally` clears the live stage.
    let stale = false;
    let retrievalFailed = false;
    try {
      // Raced against ■, so a stopped ask settles now, not when the call it
      // no longer wants comes back (minutes, for a slow model).
      const content = await Promise.race([
        stopped(ctrl.signal),
        complete({
          task: "query",
          origin, roleSnapshot, featureRole: "ask", usage: "foreground",
          cwd: vault.path,
          scope,
          tierWeights,
          paths,
          range: tp.range ?? undefined,
          retrievalQuery: context ? `${context} ${text}` : text,
          signal: ctrl.signal,
          onStage: (s) => {
            if (!live()) return;
            set({ stage: s });
            if (s.kind === "thinking" && s.stale) stale = true;
            if (s.kind === "thinking" && s.retrievalFailed) retrievalFailed = true;
          },
          messages: [
            {
              role: "system",
              content:
                SYSTEM_PREAMBLE +
                (tp.range
                  ? `\nFocus on sources dated ${tp.range.start}..${tp.range.end}.`
                  : "") +
                // A tool-using CLI can still open other files; say where to stay.
                (paths ? `\nAnswer only from these vault files: ${paths.join(", ")}.` : ""),
            },
            // Skip turns that errored or have no answer — replaying an empty
            // assistant message makes providers (e.g. Anthropic) reject the
            // request with a 400 on the next question.
            ...get()
              .turns.slice(0, -1)
              .filter((p) => p.a && !p.error)
              .flatMap((p) => [
                { role: "user" as const, content: p.q },
                { role: "assistant" as const, content: p.a },
              ]),
            { role: "user", content: question },
          ],
        }),
      ]);
      finishTurn({ a: content || copy.emptyResponse, stale, retrievalFailed, range: tp.range ?? undefined, followUp: followUp || undefined });
    } catch (err) {
      finishTurn({ a: "", error: isQueryAuthorizationError(err) ? copy.modelSelectionChanged : String(err) });
    } finally {
      // A finished run must not leave its label or its pages behind for the
      // next one.
      settle();
    }
    return outcome;
  },

  async retry(i, lang, copy) {
    const { turns, busy } = get();
    const turn = turns[i];
    if (i !== turns.length - 1 || (!turn?.error && !turn?.localFallback) || busy || !useVaultStore.getState().currentVault)
      return;
    set((s) => ({ turns: s.turns.slice(0, -1) }));
    await get().ask(turn.q, lang, copy, {
      scope: turn.scope,
      ignoreRange: turn.ignoreRange,
      note: turn.note,
      range: turn.range,
    });
  },

  stop() {
    const ctrl = running;
    running = null;
    ctrl?.abort();
  },

  async harvest(i) {
    const vault = useVaultStore.getState().currentVault;
    const turn = get().turns[i];
    if (!vault || !turn || turn.harvested) return;
    const identity = turnIdentity(turn);
    if (pendingRecallWrites.has(identity)) return;
    const revision = conversationRevision;
    pendingRecallWrites.add(identity);
    try {
      await ipc.recordRecallMiss(vault.path, turn.q);
    } catch (err) {
      // The button stays live for a retry, and the caller tells the user.
      log.warn("query.harvest_failed");
      throw err;
    } finally {
      pendingRecallWrites.delete(identity);
    }
    if (revision !== conversationRevision || useVaultStore.getState().currentVault?.path !== vault.path) return;
    set((s) => ({
      turns: s.turns.map((t, j) => (j === i && turnIdentity(t) === identity ? patchTurn(t, { harvested: true }) : t)),
    }));
  },

  async note(i, write) {
    const turn = get().turns[i];
    if (!turn || turn.noted) return;
    const revision = conversationRevision;
    const identity = turnIdentity(turn);
    const mark = (noted: boolean, notedIn?: Captured): void => {
      set((s) => {
        const current = s.turns[i];
        if (revision !== conversationRevision || !current || turnIdentity(current) !== identity) return s;
        return { turns: s.turns.map((t, j) => j === i ? patchTurn(t, { noted, notedIn }) : t) };
      });
    };
    mark(true);
    let wrote: Captured | null = null;
    try {
      wrote = await write(turn.q);
    } finally {
      mark(wrote !== null, wrote ?? undefined);
    }
  },

  markSeen: () => set({ seen: true }),

  async loadHistory() {
    const request = ++historyRequest;
    const revision = vaultRevision;
    const vault = useVaultStore.getState().currentVault;
    if (!vault || useVaultStore.getState().isOpeningVault) return set({ history: [], historyError: null });
    const isCurrent = (): boolean => request === historyRequest && revision === vaultRevision &&
      useVaultStore.getState().currentVault?.path === vault.path;
    try {
      const history = await ipc.askHistoryLoad(vault.path);
      // A vault switched meanwhile has its own load running.
      if (isCurrent())
        set({ history, historyError: null });
    } catch (err) {
      if (!isCurrent()) return;
      log.warn("query.history_load_failed");
      set({ history: [], historyError: String(err) });
    }
  },

  clear() {
    conversationRevision++;
    const ctrl = running;
    running = null;
    ctrl?.abort();
    set({ turns: [], busy: false, stage: null, startedAt: null, seen: true });
  },
}));

// A closed or replaced vault owns a separate conversation and history. Abort
// before another view can render the previous vault's answers or note scope.
useVaultStore.subscribe((state, previous) => {
  const opening = state.isOpeningVault && !previous.isOpeningVault;
  if (!opening && state.vaultToken === previous.vaultToken &&
      (state.currentVault?.path ?? null) === (previous.currentVault?.path ?? null)) return;
  vaultRevision++;
  historyRequest++;
  useQueryStore.getState().clear();
  useQueryStore.setState({ history: [], historyError: null, noteScope: null });
});
