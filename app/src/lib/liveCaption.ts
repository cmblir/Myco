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
  return { confirmed: words.slice(0, n), interim: words.slice(n) };
}

export interface PartialLoopOptions {
  /** WAV of the take so far (RecorderLike.snapshot). */
  snapshot: () => Blob;
  transcribe: (bytes: Uint8Array) => Promise<string>;
  onCaption: (caption: CaptionState) => void;
  intervalMs?: number;
  /** Past this elapsed time the caption freezes on its last text. */
  maxMs?: number;
}

/**
 * Snapshot + transcribe on a timer while a take records. One partial in
 * flight at a time — a tick that fires while one is running is skipped, so a
 * slow whisper never queues up behind itself. Returns stop(); a result that
 * lands after stop() is dropped.
 */
export function startPartialLoop(opts: PartialLoopOptions): () => void {
  const { intervalMs = 3500, maxMs = 45_000 } = opts;
  const started = Date.now();
  let caption = EMPTY_CAPTION;
  let busy = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (busy || stopped) return;
    // ponytail: the notch/spotlight memo is short-form; past 45 s each
    // snapshot is >1.4 MB re-decoded from the start every tick, so the
    // caption freezes and meeting-length audio stays on the file-drop path.
    if (Date.now() - started > maxMs) {
      clearInterval(id);
      return;
    }
    busy = true;
    try {
      const bytes = new Uint8Array(await opts.snapshot().arrayBuffer());
      const text = await opts.transcribe(bytes);
      if (stopped) return;
      caption = mergeCaption(caption, text);
      opts.onCaption(caption);
    } catch {
      // A failed partial only costs this tick's caption; the recording and
      // the final save_voice_capture transcript are untouched.
    } finally {
      busy = false;
    }
  };
  const id = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
