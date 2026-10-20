// Reading text size (UX S22): note and Ask body text scale from one CSS
// variable, --read-scale, which App sets from this choice.
//
// "system" is the default. On desktop it keeps the size the app already
// ships: what macOS text size it should follow is not settled yet. A build
// that can read the OS size (iOS Dynamic Type) plugs in here.

export const TEXT_SIZES = ["system", "small", "medium", "large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

// The reading column is 17px at 1; these land small at 15px, large at 20px.
const SCALE: Record<TextSize, number> = {
  system: 1,
  small: 15 / 17,
  medium: 1,
  large: 20 / 17,
};

export function readScale(size: TextSize): number {
  return SCALE[size];
}

export function isTextSize(v: unknown): v is TextSize {
  return TEXT_SIZES.includes(v as TextSize);
}
