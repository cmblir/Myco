// Live captions for a voice take (spotlight ⌥M and the notch). Whisper has no
// streaming mode, so the recorder's WAV-so-far is re-transcribed every few
// seconds and each result is diffed against the last: a word that came back
// at the same position twice in a row is "confirmed" (bright), the rest is
// "interim" (dim) — whisper re-decodes the tail as more context arrives, and
// showing that churn as settled text would read as the app changing its mind.

export interface CaptionState {
  confirmed: string[];
  interim: string[];
}

export const EMPTY_CAPTION: CaptionState = { confirmed: [], interim: [] };

/** Fold the next partial transcript into the caption. Empty text leaves the
 *  caption untouched (whisper says nothing for a silent clip). */
export function mergeCaption(prev: CaptionState, nextText: string): CaptionState {
  const words = nextText.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return prev;
  const seen = [...prev.confirmed, ...prev.interim];
  let n = 0;
  while (n < words.length && n < seen.length && words[n] === seen[n]) n++;
  // A partial that is a strict PREFIX of what we already have is no news —
  // whisper re-decoding the take can come back shorter, and folding it in
  // would retract words already shown as confirmed.
  if (n === words.length && seen.length > words.length) return prev;
  return { confirmed: words.slice(0, n), interim: words.slice(n) };
}

export interface PartialLoopOptions {
  /** WAV of the take so far (RecorderLike.snapshot). */
  snapshot: () => Blob;
  transcribe: (bytes: Uint8Array) => Promise<string>;
  onCaption: (caption: CaptionState) => void;
  /** Gap between the END of one partial and the start of the next. The loop
   *  is self-pacing rather than fixed-interval: a partial re-decodes the take
   *  from the start, so its cost grows with the take and a fixed interval
   *  either idles on a fast machine or piles up on a slow one. */
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
  const { gapMs = 500, leadMs = 900, maxMs = 45_000 } = opts;
  const started = Date.now();
  let caption = EMPTY_CAPTION;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<void> => {
    if (stopped) return;
    // ponytail: the notch/spotlight memo is short-form; past 45 s each
    // snapshot is >1.4 MB re-decoded from the start every pass, so the
    // caption freezes and meeting-length audio stays on the file-drop path.
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
