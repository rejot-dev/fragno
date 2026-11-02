import type { ReactNode } from "react";

export type DetailListItem = { key: string; label: string; value: ReactNode };

/**
 * Labels beside their values, one per row, for values too long to sit under a label, such as URLs
 * or lists of scopes.
 */
export function DetailList({ items }: { items: readonly DetailListItem[] }) {
  return (
    <dl className="grid min-w-0 gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
      {items.map((item) => (
        <div key={item.key} className="contents">
          <dt className="text-[var(--bo-muted-2)]">{item.label}</dt>
          <dd className="min-w-0 break-words text-[var(--bo-fg)]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
