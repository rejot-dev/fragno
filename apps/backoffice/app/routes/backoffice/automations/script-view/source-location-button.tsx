import { LocateFixed } from "lucide-react";

import type { SourceRange } from "@fragno-dev/workflow-visualizer-tokens";

export function SourceLocationButton({
  source,
  onSelect,
}: {
  source: SourceRange;
  onSelect?: (source: SourceRange) => void;
}) {
  const label = sourceLocationLabel(source);
  if (!onSelect) {
    return (
      <span className="font-mono text-[9px] text-[var(--bo-muted-2)] tabular-nums">{label}</span>
    );
  }

  return (
    <button
      type="button"
      title={`Show ${source.path}:${source.start.line}:${source.start.column + 1}`}
      onClick={() => {
        onSelect(source);
      }}
      className="flex items-center gap-1 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-1.5 py-1 font-mono text-[9px] text-[var(--bo-muted-2)] tabular-nums transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
    >
      <LocateFixed className="h-3 w-3" />
      {label}
    </button>
  );
}

function sourceLocationLabel(source: SourceRange): string {
  return source.start.line === source.end.line
    ? `L${source.start.line}:${source.start.column + 1}`
    : `L${source.start.line}–${source.end.line}`;
}
