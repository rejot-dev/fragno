import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { backofficeUiVariantClasses } from "./variants";

export const Section: ComponentFn<typeof backofficeUiCatalog, "Section"> = ({
  props,
  children,
}) => (
  <section
    aria-label={props.label}
    className={`min-w-0 border p-3 ${backofficeUiVariantClasses[props.variant ?? "neutral"]}`}
  >
    {props.label ? (
      <p className="mb-3 text-[9px] font-semibold tracking-[0.2em] uppercase opacity-80">
        {props.label}
      </p>
    ) : null}
    <div className="min-w-0">{children}</div>
  </section>
);
