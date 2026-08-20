// ROADMAP P2 — crash report viewer. Turns the last panic entry plus app/OS
// metadata into a GitHub-issue-shaped markdown block for the clipboard. Pure
// formatting only — nothing here sends anything anywhere.

export interface CrashReportInput {
  appVersion: string;
  osVersion: string;
  /** `PanicEntry.raw` — the untouched log line. */
  panicLine: string;
  /** Optional free text: what the user was doing when it crashed. */
  note?: string;
}

export function formatCrashReport(input: CrashReportInput): string {
  const note = input.note?.trim();
  return [
    "### Crash report",
    "",
    `- **App version:** ${input.appVersion}`,
    `- **OS:** ${input.osVersion}`,
    "",
    "```",
    input.panicLine,
    "```",
    "",
    // A Rust char-boundary panic embeds the offending string, which for this
    // app means a note title or a line of the user's own writing — the exact
    // bug class this viewer exists for. It is on screen before copying, but
    // pasting it into a public issue is a decision the user has to make
    // knowingly, so the block says so out loud.
    "> The line above is copied verbatim from the crash log and may quote text",
    "> from your notes. Check it before posting publicly.",
    "",
    "**What I was doing:**",
    note || "_not specified_",
  ].join("\n");
}
