import type { NormalizedTypesTraceEntry } from "../loaders/types-trace.js";
import { pathPassesFilters, type TraceFilterOptions } from "../util/filters.js";

export type FileCount = {
  file: string;
  count: number;
};

const sortFileCounts = (left: FileCount, right: FileCount): number => {
  if (left.count !== right.count) {
    return right.count - left.count;
  }

  return left.file.localeCompare(right.file);
};

export const getFileCountMap = (
  entries: readonly NormalizedTypesTraceEntry[],
  filters: TraceFilterOptions,
): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    if (!entry.declaration || !pathPassesFilters(entry.declaration, filters)) {
      continue;
    }

    const file = entry.declaration.displayPath;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }

  return counts;
};

export const getFileCounts = (
  entries: readonly NormalizedTypesTraceEntry[],
  filters: TraceFilterOptions,
): FileCount[] =>
  [...getFileCountMap(entries, filters).entries()]
    .map(([file, count]) => ({ file, count }))
    .sort(sortFileCounts);
