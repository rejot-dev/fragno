import { Metric as MetricView } from "@fragno-private/design-system/metric";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

const numberFormat = new Intl.NumberFormat("en-US");

export const Metric: ComponentFn<typeof backofficeUiCatalog, "Metric"> = ({ props }) => (
  <MetricView
    tone={props.tone ?? "muted"}
    label={props.label}
    value={typeof props.value === "number" ? numberFormat.format(props.value) : props.value}
    detail={props.detail}
  />
);
