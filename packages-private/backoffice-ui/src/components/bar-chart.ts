import { z } from "zod";

import { chartAxisSchema, chartRowsSchema, chartValueSchema, checkChartValues } from "./chart";
import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";

export const barChartDefinition = {
  props: z
    .strictObject({
      label: z.string().min(1).max(200),
      rows: chartRowsSchema,
      axis: chartAxisSchema,
      value: chartValueSchema,
      series: z.string().min(1).max(80),
    })
    .superRefine(checkChartValues),
  slots: [],
  description: `Displays a bar per axis category, stacked by the rows' series field and sized by their value field, with a legend of series totals. The ${BACKOFFICE_UI_DATA_LIMITS.chartSeries} largest series show; the rest stack as Other.`,
  example: {
    label: "Events per source",
    rows: [
      { hour: "2026-10-21T09:00:00.000Z", source: "shop", events: 4 },
      { hour: "2026-10-21T09:00:00.000Z", source: "github", events: 2 },
    ],
    axis: { field: "hour" },
    value: "events",
    series: "source",
  },
};
