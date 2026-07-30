import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

const stackGapClass = {
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-5",
} as const;

export const Stack: ComponentFn<typeof backofficeUiCatalog, "Stack"> = ({ props, children }) => (
  <div className={`flex min-w-0 flex-col ${stackGapClass[props.gap]}`}>{children}</div>
);
