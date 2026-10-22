import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

// Queries cannot round, since TanStack DB has no rounding function, so numbers round as they show.
const numberFormats = {
  integer: new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }),
  decimal: new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }),
  percent: new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 }),
} as const;

export const NumberValue: ComponentFn<typeof backofficeUiCatalog, "Number"> = ({ props }) => {
  if (props.value === null) {
    return <span className="text-xs text-[var(--bo-muted-2)]">—</span>;
  }
  const text = numberFormats[props.format].format(props.value);
  return props.tone ? (
    <span
      data-tone={props.tone}
      className="bo-status-tone text-xs whitespace-nowrap text-[var(--bo-status-color)] tabular-nums"
    >
      {text}
    </span>
  ) : (
    <span className="text-xs whitespace-nowrap text-[var(--bo-fg)] tabular-nums">{text}</span>
  );
};
