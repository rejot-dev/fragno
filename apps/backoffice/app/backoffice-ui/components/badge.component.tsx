import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { backofficeUiVariantClasses } from "./variants";

export const Badge: ComponentFn<typeof backofficeUiCatalog, "Badge"> = ({ props }) => (
  <span
    role="status"
    className={`inline-flex w-fit items-center border px-2 py-1 text-[9px] font-semibold tracking-[0.16em] uppercase ${backofficeUiVariantClasses[props.variant]}`}
  >
    {props.label}
  </span>
);
