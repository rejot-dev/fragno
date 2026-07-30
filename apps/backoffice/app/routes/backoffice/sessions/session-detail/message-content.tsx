import { Streamdown } from "streamdown";

export function MarkdownText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <Streamdown
      mode="streaming"
      className={`bo-session-markdown text-pretty ${className}`}
      controls={{ code: true, table: true }}
      skipHtml
    >
      {text}
    </Streamdown>
  );
}

export function MessageImage({ image }: { image: string }) {
  return (
    <img
      src={image}
      alt="Message attachment"
      className="max-h-96 max-w-full object-contain outline -outline-offset-1 outline-black/10 dark:outline-white/10"
    />
  );
}

export function ScrollablePre({
  children,
  expanded = false,
}: {
  children: string;
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
