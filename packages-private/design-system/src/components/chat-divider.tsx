import { Collapsible } from "@base-ui/react/collapsible";
import { useState, type ComponentProps, type ReactNode } from "react";

import {
  ActivityMarkerDot,
  DisclosureChevron,
  collapsiblePanelClassName,
  type ActivityMarker,
} from "./chat-activity";

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
      className="bo-chat-enter mb-7 flex min-w-0 items-center gap-3 text-[10px] text-[var(--bo-muted-2)]"
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

/**
 * Something that happened to the conversation rather than in it, such as a compaction or a
 * delivered event: a divider that opens to show what it carried. The body mounts only while
 * open. Spreads its props so a chat runtime can render it as a message root.
 */
export function ChatEventDisclosure({
  marker,
  title,
  note,
  time,
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "children" | "title"> & {
  marker: ActivityMarker;
  title: string;
  /** Short context beside the title, such as why or through what it happened. */
  note: string | null;
  time: Date | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div {...props} className="bo-chat-enter mb-7 min-w-0">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="group/event flex min-h-9 w-full min-w-0 items-center gap-3 text-left text-[10px] text-[var(--bo-muted-2)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30">
          <span className="h-px w-4 shrink-0 bg-[var(--bo-border)]" />
          <span className="flex min-w-0 items-center gap-2">
            <ActivityMarkerDot marker={marker} />
            <span className="truncate font-medium text-[var(--bo-muted)] transition-colors duration-150 group-hover/event:text-[var(--bo-fg)]">
              {title}
            </span>
            {note === null ? null : <span className="truncate">{note}</span>}
          </span>
          <span className="h-px min-w-4 flex-1 bg-[var(--bo-border)]" />
          {time === null ? null : (
            <time dateTime={time.toISOString()} className="shrink-0 tabular-nums">
              {timeFormatter.format(time)}
            </time>
          )}
          <DisclosureChevron open={open} />
        </Collapsible.Trigger>
        <Collapsible.Panel className={collapsiblePanelClassName}>
          <div className="mt-1 ml-[1.375rem] border-l border-[color:var(--bo-border-strong)] py-1 pl-4">
            {children}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}
