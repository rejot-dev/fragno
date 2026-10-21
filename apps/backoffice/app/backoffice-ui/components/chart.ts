import { z } from "zod";

import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";
import { intervalLabel, intervalStarts, intervalsSchema, type Intervals } from "./intervals";

const fieldSchema = z.string().min(1).max(80);

/** Rows with any fields; a chart reads the ones its props name. */
export const chartRowsSchema = z
  .array(z.record(z.string(), z.unknown()))
  .max(BACKOFFICE_UI_DATA_LIMITS.chartRows);

/** The categories along a chart, read from each row's field; with intervals, every interval. */
export const chartAxisSchema = z.strictObject({
  field: fieldSchema,
  intervals: intervalsSchema.optional(),
});

export const chartValueSchema = fieldSchema;

type ChartRow = Record<string, unknown>;

/**
 * Every row's value field holds a number or null. Bound rows are checked as they render; until
 * then rows is a state read, which this leaves to the generated-props check.
 */
export function checkChartValues(
  { rows, value }: { rows: unknown; value: unknown },
  context: z.core.$RefinementCtx,
) {
  if (!Array.isArray(rows) || typeof value !== "string") {
    return;
  }
  const index = rows.findIndex((row: ChartRow) => {
    const field = row[value];
    return field !== null && typeof field !== "number";
  });
  if (index !== -1) {
    context.addIssue({
      code: "custom",
      path: ["rows", index, value],
      message: `Expected a number or null in ${value}.`,
    });
  }
}

export type ChartCategory = { id: string; label: string };

/**
 * The categories in axis order: every interval when the axis has intervals, so empty ones show,
 * otherwise each distinct value of the axis field in row order. Rows outside the intervals drop.
 */
export function chartCategories(
  rows: readonly ChartRow[],
  axis: { field: string; intervals?: Intervals },
  now: number,
): ChartCategory[] {
  const { intervals } = axis;
  if (intervals) {
    return intervalStarts(now, intervals).map((start) => ({
      id: new Date(start).toISOString(),
      label: intervalLabel(start, intervals.every),
    }));
  }
  const ids = [...new Set(rows.map((row) => chartText(row[axis.field])))];
  return ids.map((id) => ({ id, label: id }));
}

/** A category or series name as text; times arrive from pages as ISO 8601 strings. */
export function chartText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function chartNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
