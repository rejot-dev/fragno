import type { ReactNode } from "react";

import type { BackofficeStatusTone } from "./status-tone";

/** A square-edged group of related content, tinted by the state it reports on. */
export function TonedPanel({
  tone,
  label,
  children,
}: {
  tone: BackofficeStatusTone;
  label?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      data-tone={tone}
      className="bo-status-tone bo-status-surface min-w-0 border p-3"
    >
      {label ? (
        <p className="mb-3 text-[9px] font-semibold tracking-[0.2em] uppercase opacity-80">
          {label}
        </p>
      ) : null}
      <div className="min-w-0">{children}</div>
    </section>
  );
}
