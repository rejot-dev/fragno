import { cn } from "../cn";
import { Icon, type IconName } from "./icon";

/** A square icon button that shows or hides a view in a side panel; a dot marks it shown. */
export function PanelToggleButton({
  icon,
  label,
  pressed,
  onClick,
}: {
  icon: IconName;
  /** What the panel shows, such as "Workflow graph"; the button names the action from it. */
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  const actionLabel = `${pressed ? "Hide" : "Show"} ${label} in side panel`;
  return (
    <button
      type="button"
      aria-label={actionLabel}
      aria-pressed={pressed}
      title={actionLabel}
      onClick={onClick}
      className={cn(
        "bo-control-surface relative inline-flex size-11 shrink-0 items-center justify-center bg-[var(--bo-panel)] transition-[scale,background-color,color,box-shadow] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]",
        pressed
          ? "bg-[var(--bo-selected-bg)] text-[var(--bo-fg)] ring-1 ring-[color:var(--bo-selected-border)] ring-inset"
          : "text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]",
      )}
    >
      <Icon name={icon} className="size-4" />
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[var(--bo-accent)] transition-[opacity,scale] duration-150",
          pressed ? "scale-100 opacity-100" : "scale-[0.25] opacity-0",
        )}
      />
    </button>
  );
}
