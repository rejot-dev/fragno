import { cn } from "@/lib/utils";

export function BackofficeFragmentMark({
  animated = false,
  size = "sm",
  palette = "system",
  className,
}: {
  animated?: boolean;
  size?: "sm" | "md";
  palette?: "system" | "blue";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-animated={animated || undefined}
      data-size={size}
      data-palette={palette}
      className={cn("bo-fragment-mark", className)}
    >
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
