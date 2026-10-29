import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { formatNumber } from "./number-format";

// Numbers round as they show, so a page passes the value it computed, such as a ratio.
export const NumberValue: ComponentFn<typeof backofficeUiCatalog, "Number"> = ({ props }) => {
  if (props.value === null) {
    return <span className="text-xs text-[var(--bo-muted-2)]">—</span>;
  }
  const text = formatNumber(props.value, props.format, props.signed ?? false);
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
