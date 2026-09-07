// The one control kit. Every part is a plain controlled component: props in,
// callback out, no store access — so a page decides behaviour and the kit only
// decides how a control looks and how the keyboard reaches it.
export { Button } from "./Button";
export type { ButtonProps, ButtonVariant } from "./Button";
export { IconButton } from "./IconButton";
export type { IconButtonProps } from "./IconButton";
export { Segment, nextSegmentIndex } from "./Segment";
export type { SegmentOption, SegmentProps } from "./Segment";
export { Chip } from "./Chip";
export type { ChipProps, ChipTone } from "./Chip";
export { Check } from "./Check";
export type { CheckProps } from "./Check";
export { Hero } from "./Hero";
export type { HeroProps } from "./Hero";
