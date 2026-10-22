import { Icon as IconView } from "@fragno-private/design-system/icon";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Icon: ComponentFn<typeof backofficeUiCatalog, "Icon"> = ({ props }) => (
  <span
    data-tone={props.tone ?? "muted"}
    className="bo-status-tone inline-flex shrink-0 text-[var(--bo-status-color)]"
  >
    <IconView name={props.name} className="size-4" />
  </span>
);
