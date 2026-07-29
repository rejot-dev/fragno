import type { ReactNode } from "react";

export type BackofficeStatusTone = "info" | "live" | "waiting" | "failed" | "muted";

export function BackofficeStatusLight({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: BackofficeStatusTone;
}) {
  return (
    <span
      data-tone={tone}
      className="bo-status-light inline-flex min-h-7 shrink-0 items-center gap-2 px-2 text-[9px] font-semibold tracking-[0.18em] uppercase"
    >
      <span className="bo-status-light-dot size-1.5 shrink-0" aria-hidden="true" />
      {children}
    </span>
  );
}
