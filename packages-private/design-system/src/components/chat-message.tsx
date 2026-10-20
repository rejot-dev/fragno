import type { ComponentProps, ReactNode } from "react";

import { cn } from "../cn";

// Message roots spread their props so a chat runtime can render them as its own message
// primitives; the content inside them is the runtime's rendered parts.

type ElementProps = Omit<ComponentProps<"div">, "className">;

const timeFormatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

function MessageTime({ time, className }: { time: Date; className: string }) {
  return (
    <time dateTime={time.toISOString()} className={cn("tabular-nums", className)}>
      {timeFormatter.format(time)}
    </time>
  );
}

/** What the reader wrote, right-aligned in a bubble. */
export function ChatUserMessage({
  time,
  children,
  ...props
}: ElementProps & { time: Date | null; children: ReactNode }) {
  return (
    <div
      {...props}
      data-chat-turn-start
      className="group relative mb-7 flex justify-end pl-6 sm:pl-24"
    >
      <div className="max-w-[92%] border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-3 text-sm leading-6 text-[var(--bo-fg)] sm:max-w-[88%]">
        {children}
        {time === null ? null : (
          <MessageTime
            time={time}
            className="mt-1 block text-right text-[10px] text-[var(--bo-muted-2)]"
          />
        )}
      </div>
    </div>
  );
}

/**
 * What the agent did and said in one turn. Turns made only of tool calls sit tight against the
 * next one, so a run of tool calls reads as one block.
 */
export function ChatAssistantMessage({
  spacing,
  author,
  footer,
  children,
  ...props
}: ElementProps & {
  spacing: "tight" | "normal";
  /** Shown over a final answer, not over intermediate tool work. */
  author: { name: string; time: Date | null } | null;
  footer: ReactNode | null;
  children: ReactNode;
}) {
  return (
    <div {...props} className={cn("group relative min-w-0", spacing === "tight" ? "mb-3" : "mb-9")}>
      {author === null ? null : (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] font-semibold tracking-[0.12em] text-[var(--bo-fg)] uppercase">
            {author.name}
          </span>
          {author.time === null ? null : (
            <MessageTime time={author.time} className="text-[10px] text-[var(--bo-muted-2)]" />
          )}
        </div>
      )}
      <div className="space-y-3 text-sm leading-7 text-[var(--bo-muted)]">{children}</div>
      {footer === null ? null : <div className="mt-3 space-y-3">{footer}</div>}
    </div>
  );
}

/** Something that happened to the conversation rather than in it, such as a compaction. */
export function ChatEventMessage(props: ElementProps) {
  return <div {...props} className="mb-7 min-w-0" />;
}

/** The agent's reasoning, set off by a rule so it reads as an aside. */
export function ChatReasoningTrace({ children }: { children: ReactNode }) {
  return (
    <div className="relative pl-5 text-[var(--bo-muted)] before:absolute before:top-2 before:bottom-2 before:left-1 before:w-px before:bg-[var(--bo-border-strong)]">
      {children}
    </div>
  );
}

export function ChatStoppedNotice() {
  return (
    <p className="inline-flex items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-xs text-[var(--bo-muted-2)]">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--bo-muted-2)]" />
      Response stopped
    </p>
  );
}

/** Token counts and cost for one turn. */
export function ChatTokenUsage({
  input,
  output,
  total,
  cost,
}: {
  input: number;
  output: number;
  total: number;
  /** In US dollars. */
  cost: number;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--bo-muted-2)] tabular-nums">
      <span>{input.toLocaleString()} input</span>
      <span>{output.toLocaleString()} output</span>
      <span>{total.toLocaleString()} total</span>
      <span>${cost.toFixed(4)}</span>
    </div>
  );
}

export function ChatMessageActions({ children }: { children: ReactNode }) {
  return <div className="flex min-h-10 items-center justify-end">{children}</div>;
}

/** A tool call's card, with controls for what it produced beside it. */
export function ChatToolCallRow({
  actions,
  children,
}: {
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      {actions}
    </div>
  );
}
