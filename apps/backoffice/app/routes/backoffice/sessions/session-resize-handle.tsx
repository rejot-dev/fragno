import type { KeyboardEventHandler, PointerEventHandler } from "react";

export function SessionResizeHandle({
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
  visibleFrom: "md" | "lg";
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
      className={`group relative z-30 h-full w-px shrink-0 cursor-col-resize bg-[var(--bo-border-strong)] outline-none focus-visible:bg-[var(--bo-accent)] ${visibleFrom === "md" ? "hidden md:block" : "hidden lg:block"}`}
    >
      <span className="absolute inset-y-0 -left-5 w-10 bg-transparent transition-[background-color] duration-150 group-hover:bg-[color:var(--bo-accent-bg)]/45" />
    </div>
  );
}
