import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../cn";

// Buttons share the navigation item's shape without its border line: 4px corners, sentence-case
// semibold text, and the raised selected surface. secondary is that surface, ghost is the resting navigation item,
// accent tints the surface for the default action, and solid is the page-level call to action.
export type ButtonVariant = "accent" | "secondary" | "ghost" | "solid";

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[4px] px-3 text-sm font-semibold transition-[background-color,box-shadow,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100";

const VARIANTS: Record<ButtonVariant, string> = {
  accent:
    "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)] shadow-[var(--bo-selected-shadow)] hover:bg-[color-mix(in_srgb,var(--bo-accent-bg)_82%,var(--bo-accent))]",
  secondary:
    "bg-[var(--bo-selected-bg)] text-[var(--bo-fg)] shadow-[var(--bo-selected-shadow)] hover:bg-[var(--bo-panel-2)]",
  ghost: "text-[var(--bo-fg)] hover:bg-[var(--bo-panel-2)]",
  solid:
    "bg-[var(--bo-btn-bg)] text-[var(--bo-btn-fg)] shadow-[var(--bo-selected-shadow)] hover:bg-[var(--bo-btn-bg-hover)]",
};

function buttonClassName(variant: ButtonVariant, className: string | undefined) {
  return cn(BASE, VARIANTS[variant], className);
}

export function Button({
  variant,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant: ButtonVariant }) {
  // Defaults to type="button" so a button inside a form never submits by accident.
  return <button type={type} className={buttonClassName(variant, className)} {...props} />;
}

// Navigation that should read as an action. Renders a router link, so it keeps client-side
// navigation, prefetching, and middle-click behavior that a button with onClick would lose.
export function ButtonLink({
  variant,
  className,
  ...props
}: ComponentProps<typeof Link> & { variant: ButtonVariant }) {
  return <Link className={buttonClassName(variant, className)} {...props} />;
}

// Square, borderless control for toolbar and chrome actions. The label is required because the
// icon alone gives screen readers nothing; it is also the tooltip unless a title (for example one
// naming a keyboard shortcut) overrides it.
export function IconButton({
  label,
  title = label,
  children,
  className,
  type = "button",
  ...props
}: Omit<ComponentProps<"button">, "aria-label" | "children"> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title}
      className={cn(
        "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-[4px] text-[var(--bo-muted)] transition-[background-color,color,scale] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
