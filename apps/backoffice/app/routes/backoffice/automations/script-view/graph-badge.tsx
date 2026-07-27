export function GraphBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "warning" | "active";
}) {
  const className =
    tone === "warning"
      ? "border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.16em] text-amber-800 uppercase dark:text-amber-200"
      : tone === "active"
        ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.16em] text-[var(--bo-accent-fg)] uppercase"
        : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase";

  return <span className={className}>{label}</span>;
}
