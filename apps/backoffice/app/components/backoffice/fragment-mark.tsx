import { cn } from "@/lib/utils";

export function BackofficeFragmentMark({
  animated = false,
  size = "sm",
  palette = "system",
  variant,
  className,
}: {
  animated?: boolean;
  size?: "sm" | "md";
  palette?: "system" | "blue" | "grey";
  variant?: 1 | 2 | 3 | 4;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-animated={animated || undefined}
      data-size={size}
      data-palette={palette}
      data-variant={variant}
      className={cn("bo-fragment-mark", className)}
    >
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
