import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

const stackGapClass = {
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-5",
  // Between a page's panels.
  xl: "gap-10",
} as const;

const stackDirectionClass = {
  column: "flex-col",
  // Children shrink below their content, so long text truncates instead of pushing the row wide.
  row: "flex-row items-center [&>*]:min-w-0",
} as const;

export const Stack: ComponentFn<typeof backofficeUiCatalog, "Stack"> = ({ props, children }) => (
  <div
    className={`flex min-w-0 ${stackDirectionClass[props.direction ?? "column"]} ${props.justify === "between" ? "justify-between" : ""} ${stackGapClass[props.gap]}`}
  >
    {children}
  </div>
);
