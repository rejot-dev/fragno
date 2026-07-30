import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Heading: ComponentFn<typeof backofficeUiCatalog, "Heading"> = ({ props }) => (
  <h3 className="text-sm leading-tight font-semibold text-[var(--bo-fg)]">{props.text}</h3>
);
