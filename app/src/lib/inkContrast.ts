// Which way does a colour contrast? A leaf module on purpose: the graph theme
// it serves imports sigma's WebGL renderer, so anything that lives beside it is
// untestable without a GL context. This is arithmetic and belongs on its own.

/**
 * Is `css` a dark colour — i.e. is it ink meant for a light background?
 *
 * Perceived luminance, not a channel average: the eye weights green far above
 * blue, so pure blue is dark and pure green is not, and an average would call
 * both mid-grey. Accepts the `#rrggbb` and `rgb()/rgba()` forms a computed
 * style returns; anything else reads as dark ink, which matches the light-theme
 * default rather than throwing on a colour space we do not parse.
 */
export function isDarkInk(css: string): boolean {
  const s = css.trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  const [r, g, b] = hex
    ? [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)]
    : rgb
      ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
      : [0, 0, 0];
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
