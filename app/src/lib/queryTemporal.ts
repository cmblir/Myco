import type { TemporalEvent, TemporalRecallResult } from "./ipc";
import type { Lang } from "./i18n";
import type { DateRange } from "./timeQuery";
import { displayName } from "./displayName";
import { chunkCitation } from "./retrievalContext";

const COPY = {
  en: {
    heading: "Activity overview for {start}–{end}, based on reports in the conversation, rather than verifying completed work. Each item describes its status at the time of the message, not a verified final status.",
    coverage: "Checked {scanned} of {indexed} indexed records; considered {shown} of {matched} dated excerpts found.",
    performed: "Performed / results reported", progress: "In progress / planned",
    unconfirmed: "Requests / decisions pending / completion unconfirmed",
    noPerformed: "No explicit performed-work or result report was found. Completed work cannot be established from requests or plans alone.",
    limited: "More items are present in the retrieved excerpts. Open the cited records for the full context; this overview is not a complete task inventory.",
    incomplete: "Coverage is incomplete: some records were unavailable, outdated, undated, or beyond the read limit. Reindex and try again; missing excerpts do not establish that nothing happened.",
    empty: "No dated conversation excerpts were found in the records checked for this period.",
  },
  ko: {
    heading: "{start}–{end} 대화 요약입니다. 수행 항목은 대화에서 보고한 내용이며, 실제 작업 완료를 확인한 결과는 아닙니다. 발언 당시 상태로, 최종 상태는 미확인입니다.",
    coverage: "색인된 기록 {indexed}개 중 {scanned}개를 확인했고, 찾은 날짜별 구절 {matched}개 중 {shown}개를 요약 대상으로 살펴봤습니다.",
    performed: "수행·결과 보고", progress: "진행·계획", unconfirmed: "요청·결정 대기·완료 미확인",
    noPerformed: "명확한 수행·결과 보고를 찾지 못해 실제로 완료한 작업을 확정할 수 없습니다. 요청이나 계획만으로는 완료를 확인할 수 없습니다.",
    limited: "요약에 표시하지 않은 항목이 더 있습니다. 전체 맥락은 인용한 기록에서 확인하세요. 모든 작업을 망라한 목록은 아닙니다.",
    incomplete: "일부 기록을 읽지 못했거나, 색인·날짜 정보가 부족하거나, 읽기 한도에 도달해 확인 범위가 제한됐습니다. 재색인 후 다시 찾아보세요. 구절이 없다고 그날 아무 일도 없었다는 뜻은 아닙니다.",
    empty: "확인한 기록에서 이 기간에 해당하는 대화 원문을 찾지 못했습니다.",
  },
  ja: {
    heading: "{start}〜{end} の会話の報告を状態別に整理しました。実際の作業完了を検証した結果ではありません。各項目は発言時点の状態であり、最終状態を示すものではありません。",
    coverage: "索引内の {indexed} 件中 {scanned} 件を確認し、見つかった日時付き抜粋 {matched} 件中 {shown} 件を要約対象として確認しました。",
    performed: "実施・結果の報告", progress: "進行中・計画", unconfirmed: "依頼・判断待ち・完了未確認",
    noPerformed: "明確な実施・結果の報告がなく、完了した作業を確定できません。依頼や計画だけでは完了を確認できません。",
    limited: "要約に表示していない項目があります。全体の文脈は引用元の記録で確認してください。すべての作業を網羅する一覧ではありません。",
    incomplete: "一部の記録が読めない、索引・日時情報が不足している、または読み取り上限に達したため、確認範囲は不完全です。再索引して再検索してください。抜粋がないことは、何も起きなかった証拠にはなりません。",
    empty: "確認した記録には、この期間の日時付き会話の原文が見つかりませんでした。",
  },
} satisfies Record<Lang, Record<string, string>>;

type ActivityStatus = "performed" | "progress" | "unconfirmed";

// Completion words inside requests, conditions, examples or negations are not
// performed-work evidence. Unknown wording stays unconfirmed rather than guessed.
// Leading temporal conditions are uncertain; an embedded "after" can report a past action.
const UNCONFIRMED = /[?？]|^["“'‘]|^(?:once|when|after)\b|\b(?:please|can|could|would|may|might|should|must|ensure|make sure|need your decision|choose|if|unless|example|not|never|haven['’]t|hasn['’]t|didn['’]t|wasn['’]t|weren['’]t|cannot|can['’]t|failed|pending|awaiting|waiting)\b|(?:해줘|해주세요|할까요|확인해|선택|결정.*필요|않|못|미완료|미확인|불확실|실패|예시|예를 들어|(?:완료|통과)하면|(?:완료|통과)\s*(?:후|뒤)|依頼|未完|未確認|できません|例:|場合)/i;
const PROGRESS = /\b(?:will|going to|plan(?:ning|ned)?|propos(?:e|al)|intend|running now|in progress|working on|investigating|checking|currently|started|starting)\b|(?:하고 있습니다|하는 중|진행 중|조사 중|예정|계획|하겠습니다|할 것입니다|중입니다|進行中|予定|計画|調査中)/i;
const PERFORMED = /\b(?:i|we)\s+(?:(?:have|successfully|already)\s+)?(?:fixed|implemented|updated|changed|added|removed|merged|deployed|ran|tested|verified|completed|finished|executed|built)\b|\b(?:tests?|checks?|build|suite)\b[^.!?]{0,50}\bpassed\b|(?:수정|구현|변경|추가|삭제|병합|배포|실행|검증|완료|확인|통과)(?:했습니다|하였습니다|했어요|했다|했음|됐습니다|되었습니다|됐어요|됐다)|(?:実装|修正|実行|完了|確認)しました/i;
const STATUS_HEADING = /^(?:need your decision|running now|in progress|completed|done|pending|what i did|수행·결과 보고|완료|진행 중|결정 대기)\s*:?[.!]?$/i;

function activityStatus(text: string): ActivityStatus {
  if (UNCONFIRMED.test(text)) return "unconfirmed";
  if (PROGRESS.test(text)) return "progress";
  return PERFORMED.test(text) ? "performed" : "unconfirmed";
}

/** Pick short source statements, not role headers, code or quoted examples. */
function activityStatements(event: TemporalEvent): { status: ActivityStatus; text: string }[] {
  const statements: { status: ActivityStatus; text: string }[] = [];
  let fence: string | null = null;
  let heading: ActivityStatus | null = null;
  for (const raw of event.text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^\s*>|^\s*\*\*(?:User|Assistant|System|Tool):\*\*/.test(raw)) continue;
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, "")
      .replace(/\*\*/g, "").trim();
    if (!line) continue;
    if (STATUS_HEADING.test(line)) {
      heading = /^(?:completed|done|what i did|수행·결과 보고|완료)\s*:?[.!]?$/i.test(line) ? null : activityStatus(line);
      continue;
    }
    if (/^(?:example(?: output)?|sample|test plan|acceptance criteria|예시|테스트 계획|기대 결과)\s*:?[.!]?$/i.test(line)) {
      heading = "unconfirmed";
      continue;
    }
    // A different heading ends a section's status. Only progress/pending
    // headings carry over; a "Done" heading alone cannot prove a bare item.
    if (/^\s*#{1,6}\s+/.test(raw)) { heading = null; continue; }
    for (const text of line.split(/(?<=[.!?。！？])\s+/)) {
      let status = activityStatus(text);
      if ((event.role !== "User" && event.role !== "Assistant") || /^\s*[-*+]\s+\[ \]/.test(raw)) status = "unconfirmed";
      else if (heading === "unconfirmed" || (heading === "progress" && status !== "performed" && !UNCONFIRMED.test(text))) status = heading;
      statements.push({ status, text });
    }
  }
  return statements;
}

/** Compact, attributed status overview; source reports never verify completion. */
export function formatTemporalRecall(result: TemporalRecallResult, range: DateRange, lang: Lang): string {
  const copy = COPY[lang];
  const header = copy.heading.replace("{start}", range.start).replace("{end}", range.end);
  const coverage = copy.coverage
    .replace("{indexed}", new Intl.NumberFormat(lang).format(result.indexed_pages))
    .replace("{scanned}", new Intl.NumberFormat(lang).format(result.scanned_pages))
    .replace("{matched}", new Intl.NumberFormat(lang).format(result.matched_events))
    .replace("{shown}", new Intl.NumberFormat(lang).format(result.events.length));
  const clock = new Intl.DateTimeFormat(lang, { dateStyle: "short", timeStyle: "short" });
  const groups: Record<ActivityStatus, string[]> = { performed: [], progress: [], unconfirmed: [] };
  for (const event of result.events) {
    const citation = chunkCitation({ page: event.page, stem: displayName(event.stem, event.title) });
    const role = event.role.replace(/[\r\n*[\]|]/g, "");
    for (const { status, text } of activityStatements(event)) {
      const characters = [...text];
      const brief = (characters.length > 220 ? `${characters.slice(0, 219).join("")}…` : text)
        .replace(/[\\`*_[\]<>|]/g, "\\$&");
      groups[status].push(`- ${brief} — ${clock.format(new Date(event.timestamp * 1000))} · ${role} · ${citation}`);
    }
  }
  const sections = (["performed", "progress", "unconfirmed"] as const).map((status) => {
    const items = groups[status].slice(-4);
    return items.length ? `### ${copy[status]}\n\n${items.join("\n")}` : "";
  });
  return [header, coverage, result.incomplete ? copy.incomplete : "",
    result.events.length && !groups.performed.length ? copy.noPerformed : "", ...sections,
    Object.values(groups).some((items) => items.length > 4) ? copy.limited : "",
    result.events.length ? "" : copy.empty].filter(Boolean).join("\n\n");
}
