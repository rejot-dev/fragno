/**
 * A whole read-only source file with line numbers. Its container scrolls; long lines wrap under
 * their own number instead of scrolling sideways.
 */
export function SourceView({ source, label }: { source: string; label: string }) {
  // A final newline ends the last line rather than starting an empty one.
  const lines = source.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const gutterWidth = `${String(lines.length).length}ch`;

  return (
    <pre aria-label={label} className="font-mono text-[12px] leading-6 text-[var(--bo-fg)]">
      <code>
        {lines.map((line, index) => (
          <span
            key={index}
            className="grid gap-4"
            style={{ gridTemplateColumns: `${gutterWidth} minmax(0,1fr)` }}
          >
            {/* Unselectable, so copying the source never copies line numbers. */}
            <span
              aria-hidden
              className="text-right text-[var(--bo-muted-2)] tabular-nums select-none"
            >
              {index + 1}
            </span>
            <span className="[overflow-wrap:anywhere] whitespace-pre-wrap">{line}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}
