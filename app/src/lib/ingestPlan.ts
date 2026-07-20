// Ingest plan (wikification v2, phase 2) — a structured preview of what an
// ingest will do, from one read-only model call BEFORE the writing agent runs.
// For each topic in the source it names a decision — ADD a new page, UPDATE or
// MERGE into an existing one, or NOOP because it is already covered — so the user
// sees the plan up front and the agent gets claim-level guidance, not just a page
// list. Best-effort: an unparseable reply yields no plan and ingest proceeds with
// phase-1 candidate grounding alone. Orchestrated from the frontend (like ingest
// itself); the agent still does the writing.

import type { CandidatePage } from "./ipc";
import { extractJsonArray } from "./study";

export type PlanDecision = "ADD" | "UPDATE" | "MERGE" | "NOOP";

export interface PlanItem {
  subject: string;
  decision: PlanDecision;
  /** Existing page stem for UPDATE/MERGE/NOOP; null for ADD. */
  target: string | null;
  reason: string;
}

const DECISIONS = new Set<PlanDecision>(["ADD", "UPDATE", "MERGE", "NOOP"]);
const SOURCE_BUDGET = 6000; // chars of the source shown to the planner
const MAX_ITEMS = 12;

/** The read-only prompt that asks the model to plan the ingest as decisions. */
export function buildIngestPlanPrompt(
  sourceText: string,
  candidates: CandidatePage[],
): string {
  const src = sourceText.slice(0, SOURCE_BUDGET);
  const pages =
    candidates.length > 0
      ? candidates
          .map((c) => `- ${c.stem} (similarity ${c.score.toFixed(2)})`)
          .join("\n")
      : "(none — the vault has no matching pages yet)";
  return [
    "You are planning how to ingest a new source into an existing wiki. Do NOT create or edit any files — only produce a plan.",
    "",
    "For each distinct topic or claim worth recording from the source, decide ONE:",
    "- ADD: a new page is needed (nothing existing covers it)",
    "- UPDATE: add this to an existing page (name it)",
    "- MERGE: fold this into an existing page that overlaps (name it)",
    "- NOOP: already fully covered, no change",
    "",
    "Existing pages this source may relate to:",
    pages,
    "",
    "Source:",
    '"""',
    src,
    '"""',
    "",
    `Output ONLY a JSON array, at most ${MAX_ITEMS} items, each exactly: {"subject": string, "decision": "ADD"|"UPDATE"|"MERGE"|"NOOP", "target": string|null, "reason": string}.`,
    "For ADD, target is null. For UPDATE/MERGE/NOOP, target is the existing page stem. No prose outside the JSON.",
  ].join("\n");
}

/** Prompt-and-parse (no schema-constrained output exists): tolerate ```json
 *  fences and prose, validate each item, drop the invalid. Never throws. */
export function parseIngestPlan(text: string): PlanItem[] {
  const arr = extractJsonArray(text);
  if (!arr) return [];
  const out: PlanItem[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const subject = typeof o.subject === "string" ? o.subject.trim() : "";
    const decision =
      typeof o.decision === "string"
        ? (o.decision.trim().toUpperCase() as PlanDecision)
        : ("" as PlanDecision);
    if (!subject || !DECISIONS.has(decision)) continue;
    const target =
      typeof o.target === "string" && o.target.trim()
        ? o.target
            .trim()
            .replace(/^\[\[|\]\]$/g, "")
            .replace(/\.md$/i, "")
        : null;
    const reason = typeof o.reason === "string" ? o.reason.trim() : "";
    out.push({
      subject,
      decision,
      target: decision === "ADD" ? null : target,
      reason,
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}
