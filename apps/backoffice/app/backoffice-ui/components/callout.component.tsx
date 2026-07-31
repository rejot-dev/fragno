import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { backofficeUiVariantClasses } from "./variants";

export const Callout: ComponentFn<typeof backofficeUiCatalog, "Callout"> = ({ props }) => (
  <aside
    role={props.variant === "failed" ? "alert" : "status"}
    className={`border-l-2 p-3 ${backofficeUiVariantClasses[props.variant]}`}
  >
    <p className="text-[10px] font-semibold tracking-[0.16em] uppercase">{props.title}</p>
    <p className="mt-1 text-xs leading-5 text-[var(--bo-fg)]">{props.text}</p>
  </aside>
);
