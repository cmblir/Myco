// profile.md read/parse/serialize + injection text (Phase B, Task 5). Feeds
// two consumers: the app editor (Settings -> Distill) and, independently, the
// admission gate's identity layer (Rust's `distill.rs::read_profile_
// interests`, its own plain-string-scan parser over the same section
// format — no code is shared cross-language, so keep both in sync if the
// format ever changes).

import { ipc } from "./ipc";

export interface Profile {
  role: string;
  goals: string[];
  interests: string[];
  style: string;
}

const HEADER =
  "<!-- Sent to configured AI providers when profile injection is on (Settings → 증류). -->";

type Section = "role" | "goals" | "interests" | "style" | null;

function sectionFor(heading: string): Section {
  switch (heading.trim().toLowerCase()) {
    case "role":
      return "role";
    case "goals":
      return "goals";
    case "interests":
      return "interests";
    case "working style":
      return "style";
    default:
      return null;
  }
}

/** `- text` / `* text` -> `text`, or `null` if `line` isn't a bullet. */
function bulletText(line: string): string | null {
  const m = /^[-*]\s+(.+)$/.exec(line.trim());
  return m ? m[1].trim() : null;
}

/** Parses profile.md's plain-markdown sections — frontmatter-less (see
 *  `serializeProfile`'s header comment, used instead of YAML). "## Goals"/
 *  "## Interests" collect bullet lines; "## Role"/"## Working style" join
 *  every non-empty line under the heading into one line (a hand-edited
 *  multi-line answer degrades to one sentence rather than losing all but
 *  the first line). Text outside any recognized heading is ignored. */
export function parseProfile(raw: string): Profile {
  const profile: Profile = { role: "", goals: [], interests: [], style: "" };
  let section: Section = null;
  for (const line of raw.split("\n")) {
    const heading = /^#{2}\s+(.+)$/.exec(line.trim());
    if (heading) {
      section = sectionFor(heading[1]);
      continue;
    }
    if (section === "goals" || section === "interests") {
      const item = bulletText(line);
      if (item) profile[section].push(item);
    } else if (section === "role" || section === "style") {
      const text = line.trim();
      if (text) {
        profile[section] = profile[section] ? `${profile[section]} ${text}` : text;
      }
    }
  }
  return profile;
}

/** Collapses embedded newlines to a single space so a written field value
 *  can never contain a line that reparses as a `##` heading or a `-`/`*`
 *  bullet (review-caught bug: an interests/goals item — or role/style —
 *  containing e.g. "foo\n## Working style\ninjected" corrupted the
 *  round-trip: later items were dropped and the injected text landed under
 *  the wrong field). The app's textarea can't produce embedded newlines in
 *  a list item, but MCP's `setup_profile` takes raw strings straight
 *  through, so this has to happen here at serialize, not at input time.
 *  Applied to every field including Working style — `injectionText`'s
 *  contract is one paragraph anyway, so collapsing a multi-line style
 *  answer to one line loses nothing the format uses. */
function sanitizeLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, " ").trim();
}

/** Inverse of `parseProfile` — the only writer of profile.md's shape,
 *  code-controlled (never model-written, matching every other Phase B
 *  content-writing convention: the model never writes files directly). */
export function serializeProfile(p: Profile): string {
  const bullets = (items: string[]): string =>
    items.length ? items.map((i) => `- ${sanitizeLine(i)}`).join("\n") : "";
  return (
    `${HEADER}\n\n` +
    `## Role\n${sanitizeLine(p.role)}\n\n` +
    `## Goals\n${bullets(p.goals)}\n\n` +
    `## Interests\n${bullets(p.interests)}\n\n` +
    `## Working style\n${sanitizeLine(p.style)}\n`
  );
}

/** `null` when `<vault>/profile.md` is missing OR present but entirely
 *  blank — a freshly scaffolded file nobody has answered yet is
 *  functionally "no profile," and the Ask hint chip should still offer
 *  setup either way. */
export async function loadProfile(vaultPath: string): Promise<Profile | null> {
  const file = await ipc.readFile(`${vaultPath}/profile.md`).catch(() => null);
  if (!file) return null;
  const profile = parseProfile(file.raw);
  const isBlank =
    !profile.role &&
    !profile.style &&
    profile.goals.length === 0 &&
    profile.interests.length === 0;
  return isBlank ? null : profile;
}

export async function saveProfile(vaultPath: string, p: Profile): Promise<void> {
  await ipc.writeFile(`${vaultPath}/profile.md`, serializeProfile(p));
}

const INJECTION_MAX = 600;

/** One paragraph for prepending to system context (Task 6), capped at
 *  `INJECTION_MAX` chars — a char-count truncation, not word-aware; this
 *  string is model context, not user-displayed text, so a mid-word cut at
 *  the cap is a non-issue. */
export function injectionText(p: Profile): string {
  const text =
    `User profile — role: ${p.role || "unspecified"}; ` +
    `goals: ${p.goals.join(", ") || "none"}; ` +
    `interests: ${p.interests.join(", ") || "none"}; ` +
    `style: ${p.style || "unspecified"}`;
  return text.slice(0, INJECTION_MAX);
}
