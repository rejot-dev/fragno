/** Preformatted text, such as code or a raw result, that scrolls instead of growing the page. */
export function ScrollablePre({
  children,
  expanded = false,
}: {
  children: string;
  /** Gives the text most of the viewport, for when reading it is the point. */
  expanded?: boolean;
}) {
  return (
    <pre
      className={`${expanded ? "max-h-[70vh] min-h-64" : "max-h-72"} backoffice-scroll max-w-full overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--bo-fg)]`}
    >
      {children}
    </pre>
  );
}
