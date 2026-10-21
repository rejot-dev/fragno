import { SparkBars as SparkBarsView } from "@fragno-private/design-system/spark-bars";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiRenderContext } from "../render-context";
import { chartCategories, chartNumber, chartText } from "./chart";

export const SparkBars: ComponentFn<typeof backofficeUiCatalog, "SparkBars"> = ({ props }) => {
  const { now } = useBackofficeUiRenderContext();
  const totals = new Map<string, number>();
  for (const row of props.rows) {
    const category = chartText(row[props.axis.field]);
    totals.set(category, (totals.get(category) ?? 0) + chartNumber(row[props.value]));
  }
  return (
    <SparkBarsView
      ariaLabel={props.label}
      values={chartCategories(props.rows, props.axis, now).map(({ id }) => totals.get(id) ?? 0)}
    />
  );
};
