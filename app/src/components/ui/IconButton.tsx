import { forwardRef } from "react";
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

/**
 * A 32×32 square icon button, same height as {@link Button}. Forwards its ref
 * so a page can hand focus back to it when the panel it opens closes.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ className, type = "button", ...rest }, ref): JSX.Element {
    return (
      <button
        ref={ref}
        type={type}
        className={["u-iconbtn", className ?? ""].filter(Boolean).join(" ")}
        {...rest}
      />
    );
  },
);

export default IconButton;
