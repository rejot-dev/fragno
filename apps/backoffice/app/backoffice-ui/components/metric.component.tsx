import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Metric: ComponentFn<typeof backofficeUiCatalog, "Metric"> = ({ props }) => (
  <section
    aria-label={props.label}
    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3"
  >
    <p className="text-[10px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
      {props.label}
    </p>
    <p className="mt-2 text-2xl leading-none font-semibold text-[var(--bo-fg)] tabular-nums">
      {props.value}
    </p>
  </section>
);
