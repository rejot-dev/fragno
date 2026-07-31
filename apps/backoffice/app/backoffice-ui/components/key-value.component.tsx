import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";

export const KeyValue: ComponentFn<typeof backofficeUiCatalog, "KeyValue"> = ({ props }) => {
  const items = props.items.slice(0, BACKOFFICE_UI_DATA_LIMITS.keyValueItems);

  return (
    <dl
      className={`grid min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] ${props.columns === 2 ? "sm:grid-cols-2" : "grid-cols-1"}`}
    >
      {items.map((item) => (
        <div
          key={item.key}
          className="min-w-0 border-b border-[color:var(--bo-border)] p-3 last:border-b-0 sm:border-r sm:last:border-r-0"
        >
          <dt className="text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            {item.label}
          </dt>
          <dd className="mt-1 text-xs leading-5 break-words text-[var(--bo-fg)]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
};
