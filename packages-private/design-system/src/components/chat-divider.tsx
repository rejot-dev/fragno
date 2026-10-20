import type { ComponentProps, ReactNode } from "react";

import { ActivityMarkerDot, type ActivityMarker } from "./activity-disclosure";

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** Sets apart a stretch of the thread, such as history the agent no longer has in context. */
export function ChatBoundaryDivider({ children }: { children: string }) {
  return (
    <div role="separator" className="my-12 flex items-center gap-5 text-xs text-[var(--bo-muted)]">
      <span className="h-px min-w-8 flex-1 bg-[var(--bo-border-strong)]" />
      <span className="min-w-0 text-center text-pretty">{children}</span>
      <span className="h-px min-w-8 flex-1 bg-[var(--bo-border-strong)]" />
    </div>
  );
}

/**
 * Marks a moment in the thread that needs no card, such as the agent being asked to handle the
 * notifications above. Spreads its props so a chat runtime can render it as a message root.
 */
export function ChatEventDivider({
  marker,
  time,
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "children"> & {
  marker: ActivityMarker;
  time: Date | null;
  children: ReactNode;
}) {
  return (
    <div
      {...props}
      className="mb-7 flex min-w-0 items-center gap-3 text-[10px] text-[var(--bo-muted-2)]"
    >
      <span className="h-px flex-1 bg-[var(--bo-border)]" />
      <span className="flex items-center gap-2 font-medium">
        <ActivityMarkerDot marker={marker} />
        {children}
      </span>
      <span className="h-px flex-1 bg-[var(--bo-border)]" />
      {time === null ? null : (
        <time dateTime={time.toISOString()} className="tabular-nums">
          {timeFormatter.format(time)}
        </time>
      )}
    </div>
  );
}
