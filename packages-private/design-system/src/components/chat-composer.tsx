import type { ComponentProps, ReactNode } from "react";

import { cn } from "../cn";
import { Icon } from "./icon";
import { WorkingIndicator } from "./working-indicator";

// The composer's form and buttons spread their props so a chat runtime can render them as its own
// primitives (for example through `asChild`), which supply submission and disabled state.

/** The composer's frame: waiting messages, the input, then a toolbar. */
export function ChatComposer({
  disabled,
  ...props
}: Omit<ComponentProps<"form">, "className"> & { disabled: boolean }) {
  return (
    <form
      aria-disabled={disabled}
      {...props}
      className={cn(
        "border bg-[var(--bo-panel-2)] p-2 transition-[border-color,opacity] duration-150",
        disabled
          ? "cursor-not-allowed border-[color:var(--bo-border)] opacity-50"
          : "border-[color:var(--bo-border-strong)]",
      )}
    />
  );
}

/**
 * For the composer's textarea. A class name rather than a component, because chat runtimes
 * render their own auto-growing textarea.
 */
export const chatComposerInputClassName =
  "max-h-48 min-h-14 w-full resize-none bg-transparent px-3 py-3 text-[15px] leading-6 text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] disabled:cursor-not-allowed";

/** A message waiting to reach the agent, labelled with how it will arrive. */
export function ChatComposerQueueItem({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-1 mb-1 flex items-baseline gap-2 border-l-2 border-[color:var(--bo-accent)] bg-[var(--bo-panel)] px-3 py-2 text-xs">
      <span className="shrink-0 text-[9px] font-semibold tracking-[0.12em] text-[var(--bo-accent-fg)] uppercase">
        {label}
      </span>
      <span className="line-clamp-2 min-w-0 text-pretty whitespace-pre-wrap text-[var(--bo-fg)]">
        {children}
      </span>
    </div>
  );
}

/** Context about the conversation on the left; what the reader can do on the right. */
export function ChatComposerToolbar({ start, end }: { start: ReactNode; end: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-2 px-1">
      <div className="flex min-w-0 items-center gap-2">{start}</div>
      <div className="flex items-center gap-1">{end}</div>
    </div>
  );
}

/** The model answering, hidden on narrow screens. */
export function ChatComposerModel({ children }: { children: string }) {
  return (
    <span className="hidden max-w-44 truncate px-2 text-[10px] text-[var(--bo-muted-2)] sm:block">
      {children}
    </span>
  );
}

/** Why the composer is unavailable, or what the agent is busy with; hidden on narrow screens. */
export function ChatComposerStatus({ working, children }: { working: boolean; children: string }) {
  return working ? (
    <span className="hidden sm:inline-flex">
      <WorkingIndicator>{children}</WorkingIndicator>
    </span>
  ) : (
    <span className="hidden text-xs text-[var(--bo-muted-2)] sm:inline">{children}</span>
  );
}

/** Holds a button and the menu that switches what it does, as one split button. */
export function ChatComposerSplit({ children }: { children: ReactNode }) {
  return <div className="flex items-stretch">{children}</div>;
}

/**
 * Turns speech into composer text. The microphone stays until the speech service is listening,
 * then turns into a stop control.
 */
export function ChatComposerDictationButton({
  state,
  type = "button",
  ...props
}: Omit<ComponentProps<"button">, "className" | "children"> & {
  state: "idle" | "starting" | "listening";
}) {
  return (
    <button
      type={type}
      {...props}
      className={cn(
        "inline-flex min-h-10 w-10 items-center justify-center border transition-[border-color,color,scale] duration-150 ease-out active:not-disabled:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-35",
        state === "idle"
          ? "border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] text-[var(--bo-muted)] hover:border-[color:var(--bo-accent)] hover:text-[var(--bo-fg)]"
          : "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]",
      )}
    >
      {state === "listening" ? (
        <span className="size-2.5 animate-pulse bg-[var(--bo-accent)]" />
      ) : (
        <Icon name="mic" className="size-4" />
      )}
    </button>
  );
}

/**
 * Accent sends to the agent; neutral interrupts it. A joined button is the first half of a
 * ChatComposerSplit and drops its right border into the menu trigger's.
 */
export function ChatComposerButton({
  tone,
  joined,
  type = "button",
  ...props
}: Omit<ComponentProps<"button">, "className"> & {
  tone: "accent" | "neutral";
  joined: boolean;
}) {
  return (
    <button
      type={type}
      {...props}
      className={cn(
        "inline-flex min-h-10 items-center border text-xs font-semibold transition-[border-color,scale] duration-150 ease-out active:not-disabled:scale-[0.96] disabled:cursor-not-allowed",
        tone === "accent"
          ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 text-[var(--bo-accent-fg)] hover:border-[color:var(--bo-accent-strong)] disabled:opacity-35"
          : "border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 text-[var(--bo-fg)] hover:border-[color:var(--bo-failed)]",
        joined ? "border-r-0" : null,
      )}
    />
  );
}
