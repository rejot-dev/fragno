import type { ReactNode } from "react";

export type BackofficeStatusTone = "info" | "live" | "waiting" | "failed" | "muted";

export function BackofficeStatusLight({
  children,
  tone = "info",
  dot = true,
}: {
  children: ReactNode;
  tone?: BackofficeStatusTone;
  dot?: boolean;
}) {
  return (
    <span
      data-tone={tone}
      className="bo-status-light inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-[4px] px-2 text-xs font-semibold whitespace-nowrap"
    >
      {dot ? <span className="bo-status-light-dot size-1.5 shrink-0" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
