import type { ReactNode } from "react";

/** An error that belongs to the content beside it, such as a failed send under its composer. */
export function InlineAlert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-xs text-pretty text-[var(--bo-failed)]"
    >
      {children}
    </p>
  );
}
