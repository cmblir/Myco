// Live captions for a voice take (spotlight ⌥M and the notch). Whisper has no
// streaming mode, so a WAV window of the take is re-transcribed every few
// seconds and each result is stitched onto the last by word OVERLAP: a word
// the newest pass did not just introduce is "confirmed" (bright), the newest
// pass's un-matched tail is "interim" (dim) — whisper re-decodes the tail as
// more context arrives, and showing that churn as settled text would read as
// the app changing its mind.

export interface CaptionState {
  confirmed: string[];
  interim: string[];
}

export const EMPTY_CAPTION: CaptionState = { confirmed: [], interim: [] };

/** Seconds of audio each partial decodes — the window the loop's caller
 *  snapshots (RecorderLike.snapshotTail). Fixed, so the per-pass cost stops
 *  growing with the take: measured ~1.1 s per pass at 12 s with the adaptive
 *  audio context, against 1.6 s and climbing when re-decoding the whole take. */
export const PARTIAL_WINDOW_SECS = 12;

/** Longest line kept. A sliding window has no end, and the surfaces show one
 *  or two lines anyway — without a cap the array grows for the whole take. */
const MAX_WORDS = 60;

/** whisper marks silence and noise with bracketed pseudo-words —
 *  `[BLANK_AUDIO]`, `[SOUND]`, `[MUSIC]`, `(음악)`, `[_BEG_]`. They are not
 *  speech, and the owner saw `[BLANK_AUDIO]` as the first thing the caption
 *  ever showed. Anything wholly inside one bracket pair goes. */
const NON_SPEECH = /^[[(（【][^\])）】]*[\])）】]$/u;

/**
 * Fold the next partial transcript into the caption. The window means `next`
 * no longer starts at the take's first word, so the two are joined at their
 * largest word overlap rather than a common prefix. Nothing to say — an empty
 * or all-non-speech result — leaves the caption untouched.
 */
export function mergeCaption(prev: CaptionState, nextText: string): CaptionState {
  const words = nextText
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !NON_SPEECH.test(w));
  if (words.length === 0) return prev;
  const seen = [...prev.confirmed, ...prev.interim];
  // Largest k where the last k of `seen` are the first k of `words`. k === 0
  // with a non-empty line means the window slid past everything we had, so
  // the new text is appended whole rather than thrown away.
  let k = Math.min(seen.length, words.length);
  while (k > 0 && !words.slice(0, k).every((w, i) => w === seen[seen.length - k + i])) k--;
  const merged = [...seen, ...words.slice(k)];
  const line = merged.slice(-MAX_WORDS);
  const fresh = Math.min(words.length - k, line.length);
  return {
    confirmed: line.slice(0, line.length - fresh),
    interim: line.slice(line.length - fresh),
  };
}

export interface PartialLoopOptions {
  /** WAV of the take's last PARTIAL_WINDOW_SECS (RecorderLike.snapshotTail). */
  snapshot: () => Blob;
  transcribe: (bytes: Uint8Array) => Promise<string>;
  onCaption: (caption: CaptionState) => void;
  /** Gap between the END of one partial and the start of the next. The loop
   *  is self-pacing rather than fixed-interval: whisper's wall time is the
   *  machine's business, and a fixed interval either idles on a fast machine
   *  or piles up on a slow one. */
  gapMs?: number;
  /** Delay before the first partial. */
  leadMs?: number;
  /** Past this elapsed time the caption freezes on its last text. */
  maxMs?: number;
}

/**
 * Snapshot + transcribe repeatedly while a take records, each pass starting
 * `gapMs` after the previous one finished, so only one decode is ever in
 * flight and the cadence follows the machine. Returns stop(); a result that
 * lands after stop() is dropped.
 */
export function startPartialLoop(opts: PartialLoopOptions): () => void {
  const { gapMs = 250, leadMs = 900, maxMs = 300_000 } = opts;
  const started = Date.now();
  let caption = EMPTY_CAPTION;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<void> => {
    if (stopped) return;
    // 5 minutes, not the old 45 s: that cap was about COST — every pass
    // re-decoded the whole take — and a fixed window costs the same at
    // minute five as at second five. What is left is a memo-length sanity
    // bound, so a take left running overnight is not still decoding.
    if (Date.now() - started > maxMs) return;
    try {
      const bytes = new Uint8Array(await opts.snapshot().arrayBuffer());
      const text = await opts.transcribe(bytes);
      if (stopped) return;
      caption = mergeCaption(caption, text);
      opts.onCaption(caption);
    } catch {
      // A failed partial only costs this pass's caption; the recording and
      // the final save_voice_capture transcript are untouched.
    }
    // Chained, not an interval: one decode is always in flight at most, and
    // the next starts as soon as the last finished — the lag the owner felt
    // was the fixed wait ADDED to the decode, not the decode alone.
    if (!stopped) timer = setTimeout(() => void run(), gapMs);
  };

  timer = setTimeout(() => void run(), leadMs);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
