import type { CSSProperties, JSX } from "react";
import mascotPoster from "../assets/mascot/idle.poster.png";
import { MycoMark } from "../lib/icons";
import { useUIStore } from "../stores/uiStore";
import "../styles/myco-motion.css";

export type MycoMotionVariant =
  | "idle"
  | "welcome"
  | "thinking"
  | "saving"
  | "success"
  | "empty";

export interface MycoMotionProps {
  variant?: MycoMotionVariant;
  /** Square display size in CSS pixels. The transparent character fits inside. */
  size?: number;
  className?: string;
}

/** Decorative brand motion. Pair status variants with visible, localized text. */
export default function MycoMotion({
  variant = "idle",
  size = 96,
  className = "",
}: MycoMotionProps): JSX.Element {
  const mascotEnabled = useUIStore((state) => state.mascotEnabled);
  const style = { "--myco-motion-size": `${size}px` } as CSSProperties;

  if (!mascotEnabled) {
    return (
      <span
        className={`myco-motion myco-motion--static ${className}`}
        style={style}
        aria-hidden
      >
        <MycoMark size={Math.round(size * 0.66)} />
      </span>
    );
  }

  return (
    <span
      className={`myco-motion ${className}`}
      data-variant={variant}
      style={style}
      aria-hidden
    >
      <span className="myco-motion__halo" />
      <span className="myco-motion__shadow" />
      <span className="myco-motion__figure">
        <img src={mascotPoster} alt="" draggable={false} />
      </span>
      <span className="myco-motion__signal">
        <i />
        <i />
        <i />
      </span>
      <span className="myco-motion__spark myco-motion__spark--one" />
      <span className="myco-motion__spark myco-motion__spark--two" />
    </span>
  );
}
