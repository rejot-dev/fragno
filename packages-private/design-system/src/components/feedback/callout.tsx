import type { ReactNode } from "react";

import type { BackofficeStatusTone } from "./status-tone";

/** A short note set apart from the content around it, such as a sync that is still running. */
export function Callout({
  tone,
  title,
  children,
}: {
  tone: BackofficeStatusTone;
  title: string;
  children: ReactNode;
}) {
  return (
    <aside
      role={tone === "failed" ? "alert" : "status"}
      data-tone={tone}
      className="bo-status-tone bo-status-surface border-l-2 p-3"
    >
      <p className="text-[10px] font-semibold tracking-[0.16em] uppercase">{title}</p>
      <div className="mt-1 text-xs leading-5 text-[var(--bo-fg)]">{children}</div>
    </aside>
  );
}
