/** Read-only source or diagnostic text that scrolls in place, with an optional caption. */
export function CodeBlock({
  code,
  label,
  language,
}: {
  code: string;
  label?: string;
  language?: string;
}) {
  return (
    <figure className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
      {label || language ? (
        <figcaption className="flex items-center justify-between gap-3 border-b border-[color:var(--bo-border)] px-3 py-2 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
          <span>{label ?? "Code"}</span>
          {language ? <span>{language}</span> : null}
        </figcaption>
      ) : null}
      <pre
        aria-label={label ?? "Code"}
        className="backoffice-scroll max-h-96 overflow-auto p-3 font-mono text-[11px] leading-5 whitespace-pre text-[var(--bo-fg)]"
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}
