import type { ComponentProps } from "react";
import { Link } from "react-router";

import { cn } from "../../cn";
import { Icon } from "../icon";

// The landing page's round buttons, as against Button's squared ones in the app. They draw in the
// page's ink, --bo-fg, so a dark surface that redefines its ink, as the footer and the hero do, gets
// light pills without saying so. filled is the one way in a view leads with; outlined is every other.
export type PillVariant = "filled" | "outlined";
// compact fits inside another pill, as the marketplace's search button does in its field.
export type PillSize = "default" | "compact";

const BASE =
  "group/pill inline-flex items-center justify-center gap-2 rounded-full text-sm font-semibold no-underline transition-[background-color,opacity,scale] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-60";

const VARIANTS: Record<PillVariant, string> = {
  filled: "bg-[var(--bo-fg)] text-[var(--bo-bg)] hover:opacity-85 active:scale-[0.98]",
  outlined: "border border-[color-mix(in_srgb,var(--bo-fg)_30%,transparent)] text-[var(--bo-fg)]",
};
// An outlined pill tints on hover, unless its ring already answers the hover.
const OUTLINED_HOVER = "hover:bg-[color-mix(in_srgb,var(--bo-fg)_10%,transparent)]";

const SIZES: Record<PillSize, string> = {
  default: "min-h-12 px-6",
  compact: "min-h-10 px-5",
};

/**
 * A pill's classes, for a pill drawn inside another interactive element, such as the header's
 * Open app inside its link cell. `ring` runs a ring in the logo's colors around it on hover
 * (components.css), around the pill itself or the link it sits in.
 */
export function pillClassName({
  variant,
  size,
  ring,
}: {
  variant: PillVariant;
  size: PillSize;
  ring: boolean;
}) {
  return cn(
    BASE,
    VARIANTS[variant],
    SIZES[size],
    ring ? "bo-pill-ring" : variant === "outlined" && OUTLINED_HOVER,
  );
}

export function PillButton({
  variant,
  size,
  ring,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant: PillVariant; size: PillSize; ring: boolean }) {
  // Defaults to type="button" so a button inside a form never submits by accident.
  return (
    <button
      type={type}
      className={cn(pillClassName({ variant, size, ring }), className)}
      {...props}
    />
  );
}

// Navigation that should read as a pill. Renders a router link, keeping client-side navigation.
export function PillButtonLink({
  variant,
  size,
  ring,
  className,
  ...props
}: ComponentProps<typeof Link> & { variant: PillVariant; size: PillSize; ring: boolean }) {
  return <Link className={cn(pillClassName({ variant, size, ring }), className)} {...props} />;
}

/**
 * A pill's label. The font's ascent is far taller than its caps, so an untrimmed line box centers
 * the letters low; trimmed to cap height and baseline, they center in the pill and on its arrow.
 */
export function PillLabel({ children }: { children: string }) {
  return <span className="[text-box:trim-both_cap_alphabetic]">{children}</span>;
}

/** The arrow after a pill's label, stepping forward when its pill is hovered. */
export function PillArrow() {
  return (
    <Icon
      name="arrow-right"
      className="size-3.5 transition-transform duration-150 ease-out group-hover/pill:translate-x-0.5"
    />
  );
}
