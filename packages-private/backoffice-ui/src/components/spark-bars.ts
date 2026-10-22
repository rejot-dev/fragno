import { z } from "zod";

import { chartAxisSchema, chartRowsSchema, chartValueSchema, checkChartValues } from "./chart";

export const sparkBarsDefinition = {
  props: z
    .strictObject({
      label: z.string().min(1).max(200),
      rows: chartRowsSchema,
      axis: chartAxisSchema,
      value: chartValueSchema,
    })
    .superRefine(checkChartValues),
  slots: [],
  description:
    "Displays a word-sized bar per axis category, sized by the rows' value field, for trends in rows and lists. label describes the series for screen readers.",
  example: {
    label: "Runs over the last day",
    rows: [
      { hour: "2026-10-21T09:00:00.000Z", runs: 3 },
      { hour: "2026-10-21T10:00:00.000Z", runs: 5 },
    ],
    axis: { field: "hour" },
    value: "runs",
  },
};
