// LLM cluster labels v2 (calm-cosmic-web spec B2): summarize a community's
// member note names into a short topic via the bundled local model. Design
// constraints from the spec's risk list — cost/latency/nondeterminism — shape
// everything here:
//   - The v1 top-degree name is ALWAYS shown first and stays the permanent
//     fallback; a topic only ever upgrades it, never blocks it.
//   - Results are cached in localStorage keyed by the member set, so a topic
//     is computed once per community composition, ever.
//   - Requests run strictly one at a time (the 0.5B model is synchronous and
//     shared with chat/ingest) and anything malformed is rejected → fallback.
import { ipc } from "./ipc";
import { stem } from "./graphData";

const CACHE_KEY = "memex.graph.clusterTopics.v1";
const MAX_LABEL_CHARS = 28;
const PROMPT_MEMBERS = 12; // top-degree members included in the prompt

// FNV-1a over the sorted member stems — order-independent, deterministic.
// Exported for tests.
export function memberHash(memberIds: string[]): string {
  const names = memberIds.map((id) => stem(id)).sort();
  let h = 2166136261;
  for (const n of names) {
    for (let i = 0; i < n.length; i++) {
      h ^= n.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x7c; // separator so ["ab","c"] ≠ ["a","bc"]
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function loadCache(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, string>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota or disabled — topics just recompute next session */
  }
}

// Accept only something that plausibly IS a 1-4 word topic; everything else
// (apologies, prompts echoed back, degenerate repetition) → null → fallback.
// Exported for tests.
export function sanitize(raw: string): string | null {
  const line = raw.split(/\r?\n/, 1)[0].trim();
  const label = line
    .replace(/^["'`\-–—\s]+|["'`.\s]+$/g, "")
    .replace(/\s+/g, " ");
  if (!label || label.length > MAX_LABEL_CHARS) return null;
  if (label.split(" ").length > 4) return null;
  if (/[:;{}<>|\\]/.test(label)) return null;
  return label;
}

const cache = loadCache();
// Single-flight chain: at most one local_query in the air at a time.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Resolve a short topic for a community. Returns the cached topic
 * synchronously via the returned promise when known; otherwise asks the local
 * model (serialized) and caches. Resolves null when the model is unavailable
 * or returns junk — the caller keeps its v1 fallback label.
 */
export function resolveClusterTopic(
  memberIds: string[],
  topDegreeIds: string[],
): Promise<string | null> {
  const key = memberHash(memberIds);
  const hit = cache[key];
  if (hit) return Promise.resolve(hit);

  const names = topDegreeIds.slice(0, PROMPT_MEMBERS).map((id) => stem(id));
  const prompt =
    `These wiki notes form one topic cluster: ${names.join(", ")}.\n` +
    `Name the shared topic in 1-3 words. Reply with ONLY the topic name.`;

  const run = queue.then(async () => {
    try {
      const raw = await ipc.localQuery(prompt, 16);
      const label = sanitize(raw);
      if (label) {
        cache[key] = label;
        saveCache(cache);
      }
      return label;
    } catch {
      return null; // model missing / busy → keep the fallback silently
    }
  });
  // Chain regardless of outcome so one failure doesn't wedge the queue.
  queue = run.catch(() => undefined);
  return run;
}
