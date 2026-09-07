import type { ButtonHTMLAttributes, JSX } from "react";

/**
 * `aria-label` is required, not optional: an icon button carries no text, so
 * without it a screen reader announces "button" and nothing else. Making it a
 * required prop means tsc — not a review — catches the unlabelled glyph.
 */
export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "aria-labelledby"
> & { "aria-label": string };

/** A 32×32 square icon button, same height as {@link Button}. */
export function IconButton({
  className,
  type = "button",
  ...rest
}: IconButtonProps): JSX.Element {
  return (
    <button
      type={type}
      className={["u-iconbtn", className ?? ""].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export default IconButton;
