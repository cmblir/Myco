// IME composition guard for Enter/Arrow key handlers on text inputs.
//
// Typing Korean, Japanese or Chinese goes through an input method: keystrokes
// build a candidate, and Enter COMMITS that candidate rather than meaning
// "submit". The browser still fires keydown with key === "Enter" for that
// commit, so an unguarded `if (e.key === "Enter")` fires while the user is
// mid-word — sending a half-composed question to the model, activating the
// wrong command-palette row, or submitting a dialog early.
//
// Two signals are needed, because the browsers disagree on which one they set:
//
//   - `isComposing` is the spec signal (Chromium sets it on the committing
//     keydown).
//   - `keyCode === 229` is the legacy "IME is processing this key" sentinel.
//     WebKit is the reason this matters here and not just in theory: Tauri
//     renders in WKWebView on macOS, where the committing Enter can arrive
//     after `compositionend` with isComposing already false — 229 is then the
//     only thing distinguishing it from a real submit.
//
// Checking both costs nothing and neither can be true for a genuine Enter press
// outside composition.

/** The keydown that commits an IME candidate. Legacy sentinel, still emitted. */
const IME_PROCESSING_KEYCODE = 229;

/**
 * Is this keydown part of an IME composition rather than a real key press?
 *
 * Guard every Enter (and arrow-key navigation) handler on a text input with it:
 *
 * ```ts
 * onKeyDown={(e) => {
 *   if (isComposingKey(e)) return;
 *   if (e.key === "Enter") submit();
 * }}
 * ```
 *
 * Takes the React synthetic event or a raw KeyboardEvent — it reads through to
 * `nativeEvent` when present, since React's synthetic event does not surface
 * `isComposing`.
 */
export function isComposingKey(
  e: Pick<KeyboardEvent, "isComposing" | "keyCode"> | { nativeEvent: KeyboardEvent },
): boolean {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  return native.isComposing === true || native.keyCode === IME_PROCESSING_KEYCODE;
}
