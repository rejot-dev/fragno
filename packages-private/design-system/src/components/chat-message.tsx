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
      className="bo-chat-enter group relative mb-7 flex justify-end pl-6 sm:pl-24"
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
 * What the agent did and said in one turn: a ChatActivity card for its work, then its answer.
 * The footer's actions appear on hover where the reader has a pointer.
 */
export function ChatAssistantMessage({
  author,
  footer,
  children,
  ...props
}: ElementProps & {
  author: { name: string; time: Date | null };
  footer: ReactNode | null;
  children: ReactNode;
}) {
  return (
    <div {...props} className="bo-chat-enter group relative mb-9 min-w-0">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold tracking-[0.12em] text-[var(--bo-fg)] uppercase">
          {author.name}
        </span>
        {author.time === null ? null : (
          <MessageTime time={author.time} className="text-[10px] text-[var(--bo-muted-2)]" />
        )}
      </div>
      <div className="space-y-3 text-sm leading-7 text-[var(--bo-muted)]">{children}</div>
      {footer === null ? null : <div className="mt-3 space-y-3">{footer}</div>}
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

/** Revealed on hover where the reader has a pointer, and always shown on touch screens. */
export function ChatMessageActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-end transition-opacity duration-150 focus-within:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100">
      {children}
    </div>
  );
}
