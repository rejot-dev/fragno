import type { KeyboardEventHandler, PointerEventHandler } from "react";

/** Accessible vertical divider shared by Backoffice split-panel layouts. */
export function VerticalResizeHandle({
  label,
  min,
  max,
  value,
  valueText,
  visibleFrom,
  onDoubleClick,
  onKeyDown,
  onPointerDown,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  valueText: string;
  visibleFrom: "md" | "lg" | "xl";
  onDoubleClick: () => void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={valueText}
      tabIndex={0}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      className={`relative z-30 h-full w-px shrink-0 cursor-col-resize bg-[var(--bo-border-strong)] transition-colors duration-150 outline-none hover:bg-[color-mix(in_srgb,var(--bo-border-strong),var(--bo-fg)_20%)] focus-visible:bg-[color-mix(in_srgb,var(--bo-border-strong),var(--bo-fg)_20%)] active:bg-[color-mix(in_srgb,var(--bo-border-strong),var(--bo-fg)_20%)] ${visibleFrom === "md" ? "hidden md:block" : visibleFrom === "lg" ? "hidden lg:block" : "hidden xl:block"}`}
    >
      {/* A wider, invisible grab area; only the line itself darkens. */}
      <span className="absolute inset-y-0 -left-2 w-4" />
    </div>
  );
}
