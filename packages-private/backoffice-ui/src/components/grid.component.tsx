import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

const gridColumnsClass = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
  "main-side": "grid-cols-1 items-start xl:grid-cols-[minmax(0,1fr)_22rem]",
} as const;

const gridGapClass = {
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-5",
} as const;

export const Grid: ComponentFn<typeof backofficeUiCatalog, "Grid"> = ({ props, children }) => (
  <div className={`grid min-w-0 ${gridColumnsClass[props.columns]} ${gridGapClass[props.gap]}`}>
    {children}
  </div>
);
