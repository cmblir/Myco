import HEADS from "./mycoPromptHeads.json";
import { guidedQuestionPrompt, type GuidedQuestionSelection } from "./guidedQuestion";
import type { SimpleMessage } from "./chat";

/** Shared by the app and the selected-question training fixtures. */
export const SYSTEM_PREAMBLE = `${HEADS.ask}
The current working directory is the vault root. Use Read/Grep/Glob tools to
look up answers from the wiki (\`wiki/\` if it exists) before reaching for
\`raw/\` sources. Answer in the user's language. When you state a fact that
comes from a vault file, cite it inline as [[vault-relative/path|page-stem]].
Keep the source date with historical claims. Report conflicting evidence;
an old decision or a proposed change does not establish the current state.`;

export function askPreamble(guided?: GuidedQuestionSelection): string {
  return SYSTEM_PREAMBLE + (guided ? `\n${guidedQuestionPrompt(guided)}` : "");
}

/** One system message, identical across the app and offline training. */
export function withVaultContext(messages: SimpleMessage[], ctx: string): SimpleMessage[] {
  const block =
    `Below is the current content of the user's myco vault (markdown files). ` +
    `Answer the question using ONLY the content below. Do NOT use outside ` +
    `knowledge, and do NOT invent pages, files, facts, or events. If the answer ` +
    `is not present in the content below, reply that you could not find it in ` +
    `the wiki (in the user's language) — do not guess. Cite pages you use as ` +
    `[[vault-relative/path|page-stem]], preserving the source_path shown below. ` +
    `A dated statement is evidence for that date, not proof of the current state. ` +
    `If sources disagree, state the dates and disagreement instead of silently choosing.\n\n${ctx}`;
  const sysIdx = messages.findIndex(m => m.role === "system");
  if (sysIdx >= 0) return messages.map((m, i) => i === sysIdx ? { ...m, content: `${m.content}\n\n${block}` } : m);
  return [{ role: "system", content: block }, ...messages];
}
