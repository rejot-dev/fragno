import { Metric as MetricView } from "@fragno-private/design-system/metric";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Metric: ComponentFn<typeof backofficeUiCatalog, "Metric"> = ({ props }) => (
  <MetricView
    tone={props.tone ?? "muted"}
    label={props.label}
    value={props.value}
    detail={props.detail}
  />
);
