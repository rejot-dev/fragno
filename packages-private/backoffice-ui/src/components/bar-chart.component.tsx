import { StackedBarChart } from "@fragno-private/design-system/stacked-bar-chart";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiRenderContext } from "../render-context";
import { chartCategories, chartNumber, chartText } from "./chart";
import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";

// Shown series are keyed by rank, so a series a row names "Other" stays apart from the rest.
const OTHER_SERIES = { id: "other", label: "Other" };

export const BarChart: ComponentFn<typeof backofficeUiCatalog, "BarChart"> = ({ props }) => {
  const { now } = useBackofficeUiRenderContext();
  const seriesTotals = new Map<string, number>();
  for (const row of props.rows) {
    const series = chartText(row[props.series]);
    seriesTotals.set(series, (seriesTotals.get(series) ?? 0) + chartNumber(row[props.value]));
  }
  const ranked = [...seriesTotals].sort(([, left], [, right]) => right - left);
  const shown = new Map(
    ranked
      .slice(0, BACKOFFICE_UI_DATA_LIMITS.chartSeries)
      .map(([name], rank) => [name, { id: `series-${rank}`, label: name === "" ? "None" : name }]),
  );
  const hasOther = ranked.length > shown.size;

  const values = new Map<string, Record<string, number>>();
  for (const row of props.rows) {
    const category = chartText(row[props.axis.field]);
    const { id } = shown.get(chartText(row[props.series])) ?? OTHER_SERIES;
    const bucket = values.get(category) ?? {};
    bucket[id] = (bucket[id] ?? 0) + chartNumber(row[props.value]);
    values.set(category, bucket);
  }
  return (
    <StackedBarChart
      ariaLabel={props.label}
      series={[...shown.values(), ...(hasOther ? [OTHER_SERIES] : [])]}
      buckets={chartCategories(props.rows, props.axis, now).map(({ id, label }) => ({
        id,
        label,
        values: values.get(id) ?? {},
      }))}
    />
  );
};
