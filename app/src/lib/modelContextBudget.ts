import type { CitationEvidence } from "./citationEvidence";
import type { CompleteArgs, SimpleMessage } from "./chat";
import { ipc, type AgentVaultSession, type RelatedContext, type RelatedPassage, type ScoredChunk } from "./ipc";
import type { RoleSnapshot } from "./modelRoles";
import { chunkCitation, localMessageTime } from "./retrievalContext";

/** A runtime adapter supplies its own tokenizer/template and generation reserve.
 * No character heuristic is accepted as a measured token count. */
export interface ModelContextBudget {
  contextTokens: number;
  outputTokens: number;
  countMessages(messages: SimpleMessage[]): Promise<number>;
  record?(audit: ContextPackingAudit): Promise<void>;
  /** Optional model-specific structured contract; native source validation remains authoritative. */
  prepareInput?(args: CompleteArgs, candidates: EvidencePassage[], profileSuffix: string): Promise<{
    messages: SimpleMessage[]; paths: string[]; stems: string[];
    renderAnswer(raw: string): Promise<string>;
    citationEvidence?(): CitationEvidence | undefined;
  }>;
}
/** `budget_exhausted`: the passage fits an empty allowance but not the room
 * left after earlier selections; `whole_passage_exceeds_allowance`: it never fits. */
export type EvidenceOmissionReason = "whole_passage_exceeds_allowance" | "budget_exhausted" | "newer_source_omitted" | "after_historical_cutoff" | "historical_date_unverified";
export interface HistoricalEvidenceExclusion {
  passage: EvidencePassage; reason: "after_historical_cutoff" | "historical_date_unverified";
}
/** The ranked hits behind a packing, scores only, so an audit can tell a
 * retrieval miss from a packing omission without replaying the index. */
export interface ContextRetrievalTrace {
  denseSkipped?: string | null;
  hits: {page: string; section: number; scoreRrf?: number; scoreFinal: number; similarity: number | null; exactMatch?: boolean}[];
}
export interface ContextPackingAudit {
  status?: "packed" | "base_overflow" | "final_overflow";
  omissionReasons?: Record<string, EvidenceOmissionReason>;
  messagesSha256?: string;
  promptTokens: number;
  contextTokens: number;
  outputTokens: number;
  selected: EvidencePassage[];
  omitted: EvidencePassage[];
  retrieval?: ContextRetrievalTrace;
}
export interface ContextPassageMetadata {
  page: string; stem: string; section: number; textSha256: string;
  sourceRevision?: string; speaker?: string; timestamp?: number | null;
  messageId?: string; relation?: string; anchorPage?: string; anchorSection?: number;
}
export interface ContextPackingRecord {
  version: 1; status: "packed" | "base_overflow" | "final_overflow";
  promptTokens: number; contextTokens: number; outputTokens: number;
  tokenizerRevision: string; messagesSha256: string;
  selected: ContextPassageMetadata[];
  omitted: (ContextPassageMetadata & {reason: string})[];
  retrieval?: ContextRetrievalTrace;
}
export type EvidencePassage = ScoredChunk | RelatedPassage;
export type EvidenceSelectionIntent = "progress" | "decision" | "remaining" | "recall";
const adapters = new Map<string, ModelContextBudget>();
const routeKey = (provider: string, model: string) => JSON.stringify([provider, model]);
export function registerModelContextBudget(provider: string, model: string, adapter: ModelContextBudget): () => void {
  if (!Number.isSafeInteger(adapter.contextTokens) || !Number.isSafeInteger(adapter.outputTokens) ||
      adapter.outputTokens <= 0 || adapter.contextTokens <= adapter.outputTokens) throw new Error("Invalid model context allowance");
  const key = routeKey(provider, model);
  if (adapters.has(key)) throw new Error("Model context adapter already registered");
  adapters.set(key, adapter);
  return () => { if (adapters.get(key) === adapter) adapters.delete(key); };
}
export function modelContextBudget(provider: string, model: string): ModelContextBudget | undefined {
  return adapters.get(routeKey(provider, model));
}
export class ModelContextError extends Error {
  constructor(public readonly code: "base_overflow" | "final_overflow" | "tokenizer_contract", message: string) {
    super(message); this.name = "ModelContextError";
  }
}
export interface RuntimeContextCapability {
  model: string; contextTokens: number; outputTokens: number; tokenizerRevision: string;
}
export interface ContextRuntimeBinding {
  provider: string; model: string; origin: AgentVaultSession; roleSnapshot: RoleSnapshot;
}
const allowanceValid = (value: RuntimeContextCapability, model: string) =>
  value.model === model && Number.isSafeInteger(value.contextTokens) && Number.isSafeInteger(value.outputTokens) &&
  value.outputTokens > 0 && value.contextTokens > value.outputTokens &&
  typeof value.tokenizerRevision === "string" && value.tokenizerRevision.length > 0 && value.tokenizerRevision.length <= 256;
const snapshotMessages = (messages: SimpleMessage[]) => messages.map(({role,content}) => ({role,content}));
const textSha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
const keyOf = (p: EvidencePassage) => JSON.stringify([p.page, p.section]);
const timeOf = (p: EvidencePassage) => "timestamp" in p && Number.isFinite(p.timestamp) ? p.timestamp : -Infinity;

// These are routing cues, not an answer key. Candidate passages have already
// passed retrieval/anchor checks; topical words stop a later unrelated exchange
// in a long conversation from crowding out the question's original statement.
const questionWords = new Set(["프로젝트", "기준", "질문", "마지막", "지금", "현재", "지난번", "이번", "내용", "어디까지", "했지", "했어", "알려줘", "찾아줘", "아직", "남은", "작업", "이유", "전에", "이야기한", "대화", "기록", "후속", "발언", "사용자", "이렇게", "무엇", "어떤", "progress", "decision", "remaining", "recall"]);
function topicalWords(text: string): string[] {
  const words = text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(words.map(word => {
    const base = word.replace(/(?:에서는|에서|에게|으로|별로|기로|으로는|로는|라는|이란|처럼|까지|부터|에는|에선|하고|이며|이고|이나|거나|은|는|이|가|을|를|과|와|로|에|의|도|만)$/, "");
    return base.length >= 2 ? base : word;
  }).filter(word => word.length >= 2 && !questionWords.has(word) && !/^\d+(?:년|월|일)?$/.test(word)))];
}
const correctionCue = /(?:정정|철회|취소|번복|다시\s*(?:열|검토)|완료(?:가|는|라고)?\s*(?:아니|아님)|검증(?:이|은|되지)?\s*(?:않|안|미완)|correction\b|retract\w*\b|reopen\w*\b|not\s+(?:actually\s+)?(?:done|complete|completed|verified)\b)/i;
const stateCue = /(?:완료|미완|남(?:은|아|았)|진행|검증|구현|설치|배포|끝(?:났|냈)|보류|차단|계획|예정|done\b|complet\w*\b|remain\w*\b|verif\w*\b|deploy\w*\b|plan\w*\b|blocked\b)/i;
const reasonCue = /(?:때문|위해|이유|결정|선택|합의|요청|because\b|reason\b|decid\w*\b|chose\b|request\w*\b)/i;
const originalStatement = (p: EvidencePassage) => "role" in p && (p.role === "user" || p.role === "assistant");
function intentPriority(p: EvidencePassage, intent: EvidenceSelectionIntent | undefined): number {
  if (intent === "recall") return "role" in p && p.role === "user" ? 2 : originalStatement(p) ? 1 : 0;
  if (intent === "decision") return Number(reasonCue.test(p.text)) + Number("role" in p && p.role === "user");
  if (intent === "progress" || intent === "remaining") return Number(stateCue.test(p.text));
  return 0;
}
function inferredIntent(question: string): EvidenceSelectionIntent | undefined {
  if (/(?:찾아|원래\s*(?:발언|대화)|다시\s*찾|recall\b)/i.test(question)) return "recall";
  if (/(?:왜|이유|decision\b)/i.test(question)) return "decision";
  if (/(?:남은|남아|remaining\b)/i.test(question)) return "remaining";
  if (/(?:어디까지|진행\s*상황|progress\b)/i.test(question)) return "progress";
  return undefined;
}

/** An omitted correction can invalidate an older status claim, but an
 * unrelated large recent turn cannot invalidate every original user request.
 * The generation prompt always declares this a partial evidence selection. */
function maySupersede(newer: EvidencePassage, older: EvidencePassage): boolean {
  if (!correctionCue.test(newer.text) || !stateCue.test(older.text)) return false;
  if ("role" in older && older.role === "user") return false;
  if ("anchor_page" in newer && newer.anchor_page===older.page && newer.anchor_section===older.section) return true;
  const generic = new Set(["complete", "completed", "completion", "done", "verified", "verification", "unverified", "reported", "report", "correction", "reopened", "reopen", "plan", "planned", "remaining", "정정", "취소", "철회", "완료", "미완료", "검증", "미검증", "보고", "계획", "예정", "진행", "보류", "상태", "사실", "not", "was", "is", "the", "and", "for", "after", "before", "to", "of", "in", "on", "only", "with", "without"]);
  const text = newer.text.normalize("NFC").toLowerCase();
  return topicalWords(older.text).some(word => !generic.has(word) && text.includes(word));
}

/** Discover the selected runtime's real tokenizer contract. Ordinary Ollama
 * servers can report unsupported; no model-name table invents an allowance. */
export async function runtimeModelContextBudget(binding: ContextRuntimeBinding): Promise<ModelContextBudget | undefined> {
  if (binding.provider !== "ollama") return undefined;
  const capability = await ipc.modelContextBudget(binding);
  if (capability === null) return undefined;
  if (!allowanceValid(capability, binding.model)) throw new ModelContextError("tokenizer_contract", "Selected runtime returned an invalid context capability");
  return {
    contextTokens: capability.contextTokens, outputTokens: capability.outputTokens,
    async countMessages(messages) {
      let result;
      try { result = await ipc.countModelContext({...binding, messages, tokenizerRevision: capability.tokenizerRevision}); }
      catch { throw new ModelContextError("tokenizer_contract", "Exact runtime tokenization failed; generation was not started"); }
      if (!allowanceValid(result, binding.model) || result.tokenizerRevision !== capability.tokenizerRevision ||
          result.contextTokens !== capability.contextTokens || result.outputTokens !== capability.outputTokens ||
          !Number.isSafeInteger(result.promptTokens) || result.promptTokens < 0) {
        throw new ModelContextError("tokenizer_contract", "Tokenizer capability changed or returned an invalid exact count");
      }
      return result.promptTokens;
    },
    async record(audit) {
      const messagesSha256 = audit.messagesSha256;
      if (!messagesSha256 || !/^[a-f0-9]{64}$/.test(messagesSha256)) throw new ModelContextError("tokenizer_contract", "Exact measured message identity is missing");
      const metadata = async (p: EvidencePassage) => ({page:p.page,stem:p.stem,section:p.section,textSha256:await textSha256(p.text),
        ...("source_revision" in p ? {sourceRevision:p.source_revision,speaker:p.role,
          timestamp:Number.isFinite(p.timestamp)?p.timestamp:null,messageId:p.message_id,
          relation:p.relation,anchorPage:p.anchor_page,anchorSection:p.anchor_section} : {})});
      const selected = await Promise.all(audit.selected.map(metadata));
      const omitted = await Promise.all(audit.omitted.map(async p => ({...await metadata(p),
        reason:audit.omissionReasons?.[keyOf(p)] ?? "whole_passage_exceeds_allowance"})));
      try { await ipc.recordContextPacking({...binding,audit:{version:1,status:audit.status ?? "packed",
        promptTokens:audit.promptTokens,contextTokens:audit.contextTokens,outputTokens:audit.outputTokens,
        tokenizerRevision:capability.tokenizerRevision,messagesSha256,selected,omitted,
        ...(audit.retrieval ? {retrieval:audit.retrieval} : {})}}); }
      catch { throw new ModelContextError("tokenizer_contract", "Context selection audit could not be saved; generation was not started"); }
    },
  };
}

/** Source selection is independent of any expected answer. Keep full passages,
 * round-robin accepted anchor groups, and retain metadata in the audit even
 * when compact display omits hashes and message identifiers. */
export function evidenceCandidates(hits: ScoredChunk[], related: RelatedContext | undefined, question: string, selectedIntent?: EvidenceSelectionIntent, asOf?: string,
  onHistoricalExclusion?: (exclusion: HistoricalEvidenceExclusion) => void,
): EvidencePassage[] {
  const anchors = new Map(hits.map((h, i) => [keyOf(h), i]));
  const groupKey = (page: string) => related?.source_groups?.[page] ?? page;
  const groups = new Map<string, {p: EvidencePassage; rank: number}[]>();
  const seen = new Set<string>();
  let cutoff = Infinity;
  if (asOf) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
    if (!match) throw new Error("Invalid historical reference date");
    const [year,month,day] = match.slice(1).map(Number);
    const date = new Date(year,month-1,day);
    if (date.getFullYear()!==year || date.getMonth()!==month-1 || date.getDate()!==day) throw new Error("Invalid historical reference date");
    cutoff = new Date(year,month-1,day+1).getTime()/1000;
  }
  // A historical question needs source-bound original turn metadata. A bare
  // ranked chunk has no verified event date: neither its filename, body date,
  // capture time nor file mtime can establish historical eligibility.
  const historicalExclusion = (p: EvidencePassage): HistoricalEvidenceExclusion["reason"] | undefined => {
    if (!asOf) return undefined;
    if (!("source_revision" in p) || !/^[a-f0-9]{64}$/i.test(p.source_revision) ||
        typeof p.message_id !== "string" || !p.message_id.trim() ||
        !["user","assistant","system","tool"].includes(p.role) ||
        typeof p.timestamp !== "number" || !Number.isSafeInteger(p.timestamp) ||
        !Number.isFinite(new Date(p.timestamp * 1000).getTime())) return "historical_date_unverified";
    return p.timestamp >= cutoff ? "after_historical_cutoff" : undefined;
  };
  const admit = (p: EvidencePassage): boolean => {
    const reason = historicalExclusion(p);
    if (reason) { onHistoricalExclusion?.({passage:p,reason}); return false; }
    return true;
  };
  for (const p of related?.passages ?? []) {
    const rank = anchors.get(JSON.stringify([p.anchor_page, p.anchor_section]));
    if (rank === undefined || seen.has(keyOf(p)) || !p.text.trim()) continue;
    seen.add(keyOf(p));
    // Mark seen before filtering: a duplicate untyped hit cannot reintroduce
    // an excluded future or unverified original under a weaker type.
    if (!admit(p)) continue;
    const group = groups.get(groupKey(p.anchor_page)) ?? [];
    group.push({p, rank}); groups.set(groupKey(p.anchor_page), group);
  }
  hits.forEach((p, rank) => {
    if (seen.has(keyOf(p)) || !p.text.trim()) return;
    seen.add(keyOf(p));
    if (!admit(p)) return;
    const group = groups.get(groupKey(p.page)) ?? [];
    group.push({p, rank}); groups.set(groupKey(p.page), group);
  });
  const terms = topicalWords(question);
  const intent = selectedIntent ?? inferredIntent(question);
  const matches = (p: EvidencePassage) => {
    const text = p.text.normalize("NFC").toLowerCase();
    return terms.reduce((n, term) => n + Number(text.includes(term)), 0);
  };
  // A recall asks for the statement itself: the group whose anchor verifiably
  // contains the subject's words leads, so the quoted turn is also the first
  // cited source; fused rank alone put a restating conversation first.
  const exactHits = new Set(hits.filter(h => h.exact_match === true).map(keyOf));
  const exactGroup = (group: {p: EvidencePassage; rank: number}[]) => Number(group.some(x => exactHits.has(keyOf(x.p))));
  const ordered = [...groups.values()].sort((a,b) =>
    (selectedIntent === "recall" ? exactGroup(b)-exactGroup(a) : 0) || Math.min(...a.map(x=>x.rank))-Math.min(...b.map(x=>x.rank)));
  // A state question asks for the latest record; an earlier interim turn
  // that repeats more subject words must not outrank the final report.
  const latestFirst = intent === "progress" || intent === "remaining";
  for (const group of ordered) group.sort((a,b) => {
    const am = matches(a.p), bm = matches(b.p);
    // Relevant originals/corrections get the first chance within their source
    // group. Recency is a tie-breaker, not permission to discard the topic.
    if (Boolean(am) !== Boolean(bm)) return am ? -1 : 1;
    if (originalStatement(a.p) !== originalStatement(b.p)) return originalStatement(a.p) ? -1 : 1;
    if (correctionCue.test(a.p.text) !== correctionCue.test(b.p.text)) return correctionCue.test(a.p.text) ? -1 : 1;
    const ai = intentPriority(a.p,intent), bi = intentPriority(b.p,intent);
    if (ai !== bi) return bi-ai;
    if (latestFirst && timeOf(a.p) !== timeOf(b.p)) return timeOf(a.p) > timeOf(b.p) ? -1 : 1;
    if (am !== bm) return bm-am;
    if (timeOf(a.p) !== timeOf(b.p)) return timeOf(a.p) > timeOf(b.p) ? -1 : 1;
    return a.rank-b.rank;
  });
  // An explicit question type names one subject: the best-ranked source group
  // takes the first budget slots whole; a strict round-robin would leave its
  // final report behind interim turns of other conversations.
  const result: EvidencePassage[] = [];
  const roundRobin = selectedIntent ? ordered.slice(1) : ordered;
  if (selectedIntent) for (const {p} of ordered[0] ?? []) result.push(p);
  for (let depth=0; depth<Math.max(0,...roundRobin.map(g=>g.length)); depth++) {
    for (const group of roundRobin) if (group[depth]) result.push(group[depth].p);
  }
  return result;
}
export function renderEvidence(passages: EvidencePassage[]): string {
  if (!passages.length) return "";
  const chronological = passages.map((p,index)=>({p,index})).sort((a,b)=>{
    const at=timeOf(a.p),bt=timeOf(b.p); return (at===bt?0:at<bt?-1:1)||a.index-b.index;
  });
  return ["Partial source selection; omitted evidence may change the conclusion. Recorded reports are not independent verification. Preserve speakers, dates and corrections.",
    ...chronological.map(({p})=> {
      // Speaker, time and relation attribute the statement; the revision hash,
      // message id and anchor path repeat identifiers the model cannot use and
      // stay in the audit record (see `record`).
      const provenance = "role" in p ?
        `speaker: ${p.role}\nmessage_time: ${localMessageTime(p.timestamp)}\nrelation: ${p.relation}\n` : "speaker: unknown\n";
      return `\n===== ${chunkCitation(p)} =====\nsource_path: ${p.page}\nsection: ${p.section}\n${provenance}${p.text}`;
    })].join("\n");
}
export async function packModelContext(
  candidates: EvidencePassage[], adapter: ModelContextBudget,
  messagesFor: (ctx: string) => SimpleMessage[], signal?: AbortSignal,
  sourceGroups?: Record<string,string>, historicalExclusions: HistoricalEvidenceExclusion[] = [],
  retrieval?: ContextRetrievalTrace,
): Promise<{ctx: string; messages: SimpleMessage[]; paths: string[]; stems: string[]; audit: ContextPackingAudit}> {
  const count = async (messages: SimpleMessage[]) => {
    if (signal?.aborted) throw new Error("stopped");
    const before = JSON.stringify(messages);
    const value=await adapter.countMessages(messages);
    if (JSON.stringify(messages)!==before) throw new ModelContextError("tokenizer_contract", "Tokenizer mutated the measured messages");
    if (!Number.isSafeInteger(value)||value<0) throw new ModelContextError("tokenizer_contract", "Invalid tokenizer result");
    if (signal?.aborted) throw new Error("stopped");
    return value;
  };
  const selected: EvidencePassage[]=[], omitted: EvidencePassage[]=[];
  const omissionReasons: NonNullable<ContextPackingAudit["omissionReasons"]> = {};
  for (const {passage,reason} of historicalExclusions) {
    if (!omitted.some(p=>keyOf(p)===keyOf(passage))) omitted.push(passage);
    omissionReasons[keyOf(passage)] = reason;
  }
  const omittedCorrections: EvidencePassage[] = [];
  const groupOf = (p: EvidencePassage) => sourceGroups?.[p.page] ?? p.page;
  const omit = (p: EvidencePassage, reason: EvidenceOmissionReason) => {
    if (!omitted.includes(p)) omitted.push(p);
    omissionReasons[keyOf(p)] = reason;
  };
  let ctx="", messages=snapshotMessages(messagesFor(ctx)), promptTokens=await count(messages);
  const record = async (status: NonNullable<ContextPackingAudit["status"]>) => {
    const audit: ContextPackingAudit={status,promptTokens,contextTokens:adapter.contextTokens,outputTokens:adapter.outputTokens,
      selected:[...selected],omitted:[...omitted],omissionReasons,messagesSha256:await textSha256(JSON.stringify(messages)),
      ...(retrieval ? {retrieval} : {})};
    await adapter.record?.(audit); return audit;
  };
  const fitsAlone = async (p: EvidencePassage) =>
    await count(snapshotMessages(messagesFor(renderEvidence([p]))))+adapter.outputTokens<=adapter.contextTokens;
  if (promptTokens+adapter.outputTokens>adapter.contextTokens) {
    candidates.forEach(p=>omit(p,"whole_passage_exceeds_allowance")); await record("base_overflow");
    throw new ModelContextError("base_overflow", "Question and conversation exceed model context allowance; start a new conversation or shorten the question");
  }
  for (const p of candidates) {
    if (omittedCorrections.some(newer => groupOf(newer)===groupOf(p) && timeOf(p)<timeOf(newer) && maySupersede(newer,p))) {
      omit(p,"newer_source_omitted"); continue;
    }
    const trial=renderEvidence([...selected,p]); const n=await count(snapshotMessages(messagesFor(trial)));
    if (n+adapter.outputTokens<=adapter.contextTokens) { selected.push(p);ctx=trial;promptTokens=n; }
    else {
      omit(p,await fitsAlone(p) ? "budget_exhausted" : "whole_passage_exceeds_allowance");
      if (Number.isFinite(timeOf(p)) && correctionCue.test(p.text)) {
        omittedCorrections.push(p);
        // An omitted later correction must not leave only its earlier claim.
        for (let i=selected.length-1;i>=0;i--) if (groupOf(selected[i])===groupOf(p) && timeOf(selected[i])<timeOf(p) && maySupersede(p,selected[i])) {
          omit(selected[i],"newer_source_omitted");selected.splice(i,1);
        }
        ctx=renderEvidence(selected);
      }
    }
  }
  // Freeze the complete final system/profile/history/question/evidence ordering.
  // The caller dispatches this exact snapshot instead of rebuilding the prompt.
  messages=snapshotMessages(messagesFor(ctx)); promptTokens=await count(messages);
  const audit=await record(promptTokens+adapter.outputTokens>adapter.contextTokens?"final_overflow":"packed");
  if (promptTokens+adapter.outputTokens>adapter.contextTokens) throw new ModelContextError("final_overflow", "Final model context exceeded allowance");
  return {ctx,messages,paths:[...new Set(selected.map(p=>p.page))],stems:[...new Set(selected.map(p=>p.stem))],audit};
}
