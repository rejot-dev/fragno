import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { InlineAlert } from "../feedback/inline-alert";

// Below this height, such as above an on-screen keyboard on a phone on its side, the prompt and the
// action that sends it would not fit under the introduction.
const COMPACT_HEIGHT_PX = 352;

/**
 * Introduces an agent before its first turn, centered over the prompt that starts it. Where the
 * panel is short, it shows only the prompt.
 */
export function ChatStartPanel({
  title,
  description,
  details,
  children,
}: {
  title: string;
  description: string;
  /** Facts that shape the conversation, such as the agent's permissions. */
  details: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      setCompact(panel.clientHeight < COMPACT_HEIGHT_PX);
    });
    observer.observe(panel);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={panelRef}
      data-compact={compact || undefined}
      className="group/start backoffice-scroll h-full overflow-y-auto"
    >
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-4 py-8 group-data-compact/start:py-3 sm:px-8">
        <div className="group-data-compact/start:hidden">
          <h2 className="text-xl font-semibold tracking-[-0.02em] text-balance text-[var(--bo-fg)] sm:text-2xl">
            {title}
          </h2>
          <p className="mt-2 text-sm text-pretty text-[var(--bo-muted)]">{description}</p>
          <div className="mt-2 mb-5">{details}</div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A roomy labelled textarea for writing a first message, two lines in a compact start panel. */
export function ChatPromptField({
  id,
  label,
  ...props
}: Omit<ComponentProps<"textarea">, "className" | "id"> & { id: string; label: string }) {
  return (
    <div className="bo-input">
      <label
        htmlFor={id}
        className="block px-4 pt-3 text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase group-data-compact/start:sr-only"
      >
        {label}
      </label>
      {/* The bottom scroll margin is room Safari keeps below the field when it scrolls it above the
          keyboard, for the action that sends what is typed. */}
      <textarea
        id={id}
        {...props}
        className="block min-h-28 w-full resize-none scroll-mb-20 bg-transparent px-4 pt-2 pb-4 text-base leading-7 text-[var(--bo-fg)] outline-none group-data-compact/start:h-18 group-data-compact/start:min-h-0! group-data-compact/start:pb-2 placeholder:text-[var(--bo-muted-2)] sm:min-h-32"
      />
    </div>
  );
}

/**
 * A note about the first turn, such as who pays for it, beside the action that sends it, and above
 * it on narrow screens unless the start panel is compact.
 */
export function ChatStartFooter({
  note,
  action,
  alert,
}: {
  note: string;
  action: ReactNode;
  alert: string | null;
}) {
  return (
    <>
      <div className="gap-x-gutter mt-3 grid gap-y-2 group-data-compact/start:grid-cols-[minmax(0,1fr)_auto] group-data-compact/start:items-center sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <p className="text-xs text-[var(--bo-muted)]">{note}</p>
        {action}
      </div>
      {alert === null ? null : (
        <div className="mt-3">
          <InlineAlert>{alert}</InlineAlert>
        </div>
      )}
    </>
  );
}

/** Questions a reader may start with; picking one writes it into the prompt, to send or change. */
export function ChatStartSuggestions({
  suggestions,
  onPick,
}: {
  suggestions: readonly string[];
  onPick: (suggestion: string) => void;
}) {
  return (
    <ul className="mt-4 flex flex-wrap gap-2" aria-label="Suggestions">
      {suggestions.map((suggestion) => (
        <li key={suggestion}>
          <button
            type="button"
            onClick={() => {
              onPick(suggestion);
            }}
            className="border border-[color:var(--bo-border)] px-3 py-1.5 text-left text-xs text-[var(--bo-muted)] transition-colors duration-150 outline-none hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30"
          >
            {suggestion}
          </button>
        </li>
      ))}
    </ul>
  );
}
