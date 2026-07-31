import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";
import { backofficeUiVariantClasses } from "./variants";

export const List: ComponentFn<typeof backofficeUiCatalog, "List"> = ({ props }) => {
  const items = props.items.slice(0, BACKOFFICE_UI_DATA_LIMITS.listItems);
  const omittedItemCount = Math.max(0, props.items.length - items.length);

  return (
    <div className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <ul className="divide-y divide-[color:var(--bo-border)]">
        {items.map((item) => (
          <li key={item.key} className="flex min-w-0 items-start gap-3 p-3">
            <span
              className={`mt-1.5 size-1.5 shrink-0 border ${backofficeUiVariantClasses[item.variant ?? "neutral"]}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-xs leading-5 font-semibold text-[var(--bo-fg)]">{item.title}</p>
                {item.status ? (
                  <span
                    role="status"
                    className={`shrink-0 border px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.14em] uppercase ${backofficeUiVariantClasses[item.variant ?? "neutral"]}`}
                  >
                    {item.status}
                  </span>
                ) : null}
              </div>
              {item.detail ? (
                <p className="mt-1 text-[11px] leading-5 text-[var(--bo-muted)]">{item.detail}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {omittedItemCount > 0 ? (
        <p
          role="status"
          className="border-t border-[color:var(--bo-border)] px-3 py-2 text-[10px] text-[var(--bo-muted-2)]"
        >
          Showing the first {items.length} of {props.items.length} items.
        </p>
      ) : null}
    </div>
  );
};
