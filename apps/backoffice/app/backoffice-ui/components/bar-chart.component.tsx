import { StackedBarChart } from "@fragno-private/design-system/stacked-bar-chart";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiRenderContext } from "../render-context";
import { chartCategories, chartNumber, chartText } from "./chart";
import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";

const OTHER_SERIES = "Other";

export const BarChart: ComponentFn<typeof backofficeUiCatalog, "BarChart"> = ({ props }) => {
  const { now } = useBackofficeUiRenderContext();
  const seriesTotals = new Map<string, number>();
  for (const row of props.rows) {
    const series = chartText(row[props.series]);
    seriesTotals.set(series, (seriesTotals.get(series) ?? 0) + chartNumber(row[props.value]));
  }
  const ranked = [...seriesTotals].sort(([, left], [, right]) => right - left);
  const shown = ranked.slice(0, BACKOFFICE_UI_DATA_LIMITS.chartSeries).map(([series]) => series);
  const hasOther = ranked.length > shown.length;

  const values = new Map<string, Record<string, number>>();
  for (const row of props.rows) {
    const category = chartText(row[props.axis.field]);
    const name = chartText(row[props.series]);
    const series = shown.includes(name) ? name : OTHER_SERIES;
    const bucket = values.get(category) ?? {};
    bucket[series] = (bucket[series] ?? 0) + chartNumber(row[props.value]);
    values.set(category, bucket);
  }
  return (
    <StackedBarChart
      ariaLabel={props.label}
      series={[...shown, ...(hasOther ? [OTHER_SERIES] : [])].map((id) => ({
        id,
        label: id === "" ? "None" : id,
      }))}
      buckets={chartCategories(props.rows, props.axis, now).map(({ id, label }) => ({
        id,
        label,
        values: values.get(id) ?? {},
      }))}
    />
  );
};
