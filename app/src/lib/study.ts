// Study-artifact generation for Feature 3. Prompts the selected model (via the
// existing read-only chat stack, so the bundled offline model and any opt-in
// provider both work) to turn a page's markdown into flashcards / a quiz.
//
// Generation runs as the `query` task — it only READS the vault, never writes —
// so no tool-capable provider is required. The model returns strict JSON, which
// we extract, validate, and de-dupe. Malformed output is retried once, then the
// whole call fails loudly (never write partial cards).

import { complete } from "./chat";
import type { Card } from "./cards";

export interface QuizQuestion {
  question: string;
  /** 2–4 answer options; the first correct one is indexed by `answer`. */
  choices: string[];
  /** Index into `choices` of the correct option. */
  answer: number;
  /** Citation copied from the source, e.g. "[^src-3]" or "[[stem]]". */
  sourceRef: string;
  explanation: string;
}

const CARD_SYSTEM =
  "You are Memex's study-card generator. You turn a markdown note into concise " +
  "active-recall flashcards. Each card is a single clear question and a short " +
  "answer drawn ONLY from the note. Preserve source grounding: copy the nearest " +
  "citation token ([^src-*] or [[stem]]) from the span the card is based on into " +
  "sourceRef (empty string if none). Reply with ONLY a JSON array, no prose.";

const QUIZ_SYSTEM =
  "You are Memex's quiz generator. You turn a markdown note into multiple-choice " +
  "questions with exactly one correct option. Draw everything ONLY from the note. " +
  "Copy the nearest citation token ([^src-*] or [[stem]]) into sourceRef (empty " +
  "string if none) and add a one-line explanation. Reply with ONLY a JSON array.";

function cardPrompt(markdown: string, count: number): string {
  return (
    `Generate up to ${count} flashcards from the note below. ` +
    `Format: a JSON array of objects {"front": string, "back": string, "sourceRef": string}. ` +
    `front = question, back = concise answer.\n\nNOTE:\n${markdown}`
  );
}

function quizPrompt(markdown: string, count: number): string {
  return (
    `Generate up to ${count} multiple-choice questions from the note below. ` +
    `Format: a JSON array of objects ` +
    `{"question": string, "choices": string[2..4], "answer": number, "sourceRef": string, "explanation": string}. ` +
    `"answer" is the 0-based index of the correct choice.\n\nNOTE:\n${markdown}`
  );
}

/** Extract the first top-level JSON array from a model reply, tolerating
 *  ```json fences and surrounding prose. Returns null if none parses. */
export function extractJsonArray(text: string): unknown[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], sliceArray(text), text];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const parsed = JSON.parse(c.trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Substring from the first '[' to its matching ']' (bracket-balanced). */
function sliceArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Run the model, extract a JSON array, retrying once on malformed output. */
async function generateArray(
  vaultPath: string,
  system: string,
  user: string,
): Promise<unknown[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await complete({
      task: "query",
      cwd: vaultPath,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const arr = extractJsonArray(reply);
    if (arr) return arr;
  }
  throw new Error("The model did not return valid JSON. Try again.");
}

export async function generateCards(
  vaultPath: string,
  markdown: string,
  count = 8,
): Promise<Card[]> {
  const raw = await generateArray(
    vaultPath,
    CARD_SYSTEM,
    cardPrompt(markdown, count),
  );
  const seen = new Set<string>();
  const cards: Card[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const front = str(o.front);
    const back = str(o.back);
    if (!front || !back) continue;
    const key = front.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({ front, back, sourceRef: str(o.sourceRef), state: null });
    if (cards.length >= count) break;
  }
  return cards;
}

export async function generateQuiz(
  vaultPath: string,
  markdown: string,
  count = 5,
): Promise<QuizQuestion[]> {
  const raw = await generateArray(
    vaultPath,
    QUIZ_SYSTEM,
    quizPrompt(markdown, count),
  );
  const out: QuizQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const question = str(o.question);
    const choices = Array.isArray(o.choices)
      ? o.choices.map(str).filter(Boolean)
      : [];
    const answer = Number(o.answer);
    if (
      !question ||
      choices.length < 2 ||
      !Number.isInteger(answer) ||
      answer < 0 ||
      answer >= choices.length
    ) {
      continue;
    }
    out.push({
      question,
      choices,
      answer,
      sourceRef: str(o.sourceRef),
      explanation: str(o.explanation),
    });
    if (out.length >= count) break;
  }
  return out;
}
