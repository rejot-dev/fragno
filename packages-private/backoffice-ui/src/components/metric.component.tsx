import { Metric as MetricView } from "@fragno-private/design-system/metric";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { formatNumber } from "./number-format";

export const Metric: ComponentFn<typeof backofficeUiCatalog, "Metric"> = ({ props }) => (
  <MetricView
    tone={props.tone ?? null}
    label={props.label}
    value={
      typeof props.value === "number"
        ? formatNumber(props.value, props.format ?? "decimal", props.signed ?? false)
        : props.value
    }
    detail={props.detail}
  />
);
