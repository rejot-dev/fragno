import type { ReactNode } from "react";

/** A small uppercase caption over content, with room for one action beside the caption. */
export function LabeledSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex min-h-8 items-center justify-between gap-2">
        <p className="text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
          {label}
        </p>
        {action}
      </div>
      {children}
    </section>
  );
}
