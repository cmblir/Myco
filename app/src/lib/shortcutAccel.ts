// Turn a keypress into the accelerator string Rust registers, for the
// "record a shortcut" control in Settings.
//
// No key-name table is needed: `KeyboardEvent.code` values ("Space", "KeyK",
// "Digit1", "ArrowUp") ARE the names global-hotkey's parser accepts — it
// uppercases the token and matches Code variants (verified in
// global-hotkey-0.8.0/src/hotkey.rs `parse_key`). So the recorder is modifiers
// plus the raw `code`.

/** A modifier key held down on its own — the user is mid-combination, not done. */
const BARE_MODIFIER = /^(Control|Alt|Shift|Meta)(Left|Right)$/;

/**
 * The accelerator this keypress means ("Alt+Space", "Control+Shift+KeyK"), or
 * `null` when it is not a usable global shortcut yet:
 *
 * - only a modifier is down (still composing the combination), or
 * - there is no modifier at all. A modifier-less global shortcut would
 *   swallow that key in every other application, so it is refused here rather
 *   than registered and blamed on the OS later.
 */
export function accelFromEvent(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
): string | null {
  if (!e.code || BARE_MODIFIER.test(e.code)) return null;
  const mods: string[] = [];
  // Order does not matter to the parser, but a stable one keeps the string
  // shown in Settings identical for the same keypress.
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Command");
  if (mods.length === 0) return null;
  return [...mods, e.code].join("+");
}

/** How the accelerator is shown to a user: macOS glyphs, plain words
 *  elsewhere. Purely cosmetic — the stored string stays the parser's format. */
export function formatAccel(accel: string, isMac: boolean): string {
  if (!accel) return "";
  const symbols: Record<string, string> = {
    Control: "⌃",
    Alt: "⌥",
    Shift: "⇧",
    Command: "⌘",
  };
  return accel
    .split("+")
    .map((token) => {
      if (isMac && symbols[token]) return symbols[token];
      // "KeyK" → "K", "Digit1" → "1"; everything else reads fine as-is.
      return token.replace(/^Key/, "").replace(/^Digit/, "");
    })
    .join(isMac ? "" : "+");
}
