import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { backofficeUiVariantClasses } from "./variants";

export const Metric: ComponentFn<typeof backofficeUiCatalog, "Metric"> = ({ props }) => (
  <section
    aria-label={props.label}
    className={`border p-3 ${backofficeUiVariantClasses[props.variant ?? "neutral"]}`}
  >
    <p className="text-[9px] font-semibold tracking-[0.18em] uppercase opacity-80">{props.label}</p>
    <p className="mt-2 text-2xl leading-none font-semibold text-[var(--bo-fg)] tabular-nums">
      {props.value}
    </p>
    {props.detail ? (
      <p className="mt-2 text-[10px] leading-4 text-[var(--bo-muted)]">{props.detail}</p>
    ) : null}
  </section>
);
