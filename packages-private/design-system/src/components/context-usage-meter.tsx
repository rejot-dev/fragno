const tokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// Agents compact automatically near a full contextWindow, so the meter warns before that happens.
const WARNING_RATIO = 0.8;

/** How much of a model's context window a conversation fills, as a compact inline reading. */
export function ContextUsageMeter({
  tokens,
  contextWindow,
}: {
  tokens: number;
  /** Null when the model's window is unknown; the meter then shows the token count alone. */
  contextWindow: number | null;
}) {
  if (contextWindow === null) {
    return (
      <span
        title={`${tokens.toLocaleString()} estimated context tokens`}
        className="border-l border-[color:var(--bo-border)] px-2 text-[10px] text-[var(--bo-muted-2)] tabular-nums"
      >
        {tokenFormatter.format(tokens)} context
      </span>
    );
  }
  const ratio = tokens / contextWindow;
  return (
    <span
      title={`${tokens.toLocaleString()} of ${contextWindow.toLocaleString()} estimated context tokens`}
      className={`border-l border-[color:var(--bo-border)] px-2 text-[10px] tabular-nums ${ratio >= WARNING_RATIO ? "text-[var(--bo-waiting)]" : "text-[var(--bo-muted-2)]"}`}
    >
      {Math.min(100, Math.round(ratio * 100))}% context
    </span>
  );
}
