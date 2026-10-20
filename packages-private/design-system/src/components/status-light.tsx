import type { ReactNode } from "react";

import { cn } from "../cn";
import type { BackofficeStatusTone } from "./status-tone";

export function BackofficeStatusLight({
  children,
  tone = "info",
  dot = true,
  wrap = false,
  role,
}: {
  children: ReactNode;
  tone?: BackofficeStatusTone;
  dot?: boolean;
  /** Wraps within the container instead of keeping one line, for labels of unbounded length. */
  wrap?: boolean;
  /** Announces text changes to screen readers, for statuses that update in place. */
  role?: "status";
}) {
  return (
    <span
      data-tone={tone}
      role={role}
      className={cn(
        "bo-status-tone bo-status-light inline-flex min-h-6 items-center gap-1.5 rounded-[4px] px-2 text-xs font-semibold",
        wrap ? "w-fit max-w-full py-1 [overflow-wrap:anywhere]" : "shrink-0 whitespace-nowrap",
      )}
    >
      {dot ? <span className="bo-status-light-dot size-1.5 shrink-0" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
