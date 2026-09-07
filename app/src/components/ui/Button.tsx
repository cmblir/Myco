import type { ButtonHTMLAttributes, JSX } from "react";

/**
 * Emphasis ladder, descending: `primary` is the one action a page is for,
 * `ghost` is the ordinary outlined button, `quiet` is the bare one used for
 * repeated or secondary actions. There is no fourth level — six button
 * flavours across the app is the thing this replaces.
 */
export type ButtonVariant = "primary" | "ghost" | "quiet";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

/**
 * The app's only button. One 32px height, one radius, one focus ring.
 * Defaults to `type="button"` because a bare <button> inside a form submits
 * it, which is never what a toolbar action means.
 */
export function Button({
  variant = "ghost",
  className,
  type = "button",
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    "u-btn",
    variant === "ghost" ? "" : `u-btn--${variant}`,
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...rest} />;
}

export default Button;
