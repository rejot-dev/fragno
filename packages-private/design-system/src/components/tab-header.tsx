import type { ReactNode } from "react";

import { OverflowTabRow, type OverflowTabRowItem } from "./overflow-tab-row";

/**
 * The capped, centered column that a page's tabs and content share, so wide screens keep tables
 * and panels readable and the first tab sits right above the content.
 */
export const backofficePageColumnClassName = "mx-auto w-full max-w-[96rem]";

/**
 * The tab row every top-level page opens with. A page without siblings still shows its one tab, so
 * moving between pages never shifts where the content starts.
 */
export function BackofficeTabHeader({
  items,
  ariaLabel,
  options,
}: {
  items: readonly OverflowTabRowItem[];
  ariaLabel: string;
  options: ReactNode | null;
}) {
  return (
    <header className="flex-none border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      {/* Tabs sit on the bottom edge so the selected underline lands on the header divider. */}
      <div className={`${backofficePageColumnClassName} flex h-16 items-end gap-3 px-2 sm:px-4`}>
        <div className="-mb-px min-w-0 flex-1">
          <OverflowTabRow items={items} ariaLabel={ariaLabel} variant="underline" />
        </div>
        {options ? (
          <div className="flex shrink-0 items-center gap-2 self-center sm:gap-3">{options}</div>
        ) : null}
      </div>
    </header>
  );
}
