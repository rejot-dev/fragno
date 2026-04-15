import type { NormalizedTypesTraceEntry } from "../loaders/types-trace.js";
import { pathPassesFilters, type TraceFilterOptions } from "../util/filters.js";
import { pathMatchesQuery, normalizePathQuery } from "../util/paths.js";

export const anonymousSymbolNames = ["__type", "__object", "__function"] as const;

export type SymbolCount = {
  symbol: string;
  count: number;
};

export type SymbolSummary = SymbolCount & {
  sampleDisplays: string[];
};

export type RawFileSample = {
  id: number;
  symbol: string;
  display?: string;
  declarationRange?: string;
};

export type FileAnalysisResult = {
  file: string;
  entryCount: number;
  symbolCounts: SymbolSummary[];
  anonymousGroups: SymbolCount[];
  rawSamples: RawFileSample[];
};

export type SymbolFileCount = {
  file: string;
  count: number;
};

export type SymbolAnalysisResult = {
  symbol: string;
  totalCount: number;
  declarationFiles: SymbolFileCount[];
  sampleDisplays: string[];
};

const sortSymbolCounts = (left: SymbolCount, right: SymbolCount): number => {
  if (left.count !== right.count) {
    return right.count - left.count;
  }

  return left.symbol.localeCompare(right.symbol);
};

const formatDeclarationRange = (entry: NormalizedTypesTraceEntry): string | undefined => {
  const start = entry.declaration?.start;
  const end = entry.declaration?.end;

  if (!start || !end) {
    return undefined;
  }

  return `${start.line}:${start.character}-${end.line}:${end.character}`;
};

const collectSampleDisplays = (
  entries: readonly NormalizedTypesTraceEntry[],
  sampleLimit: number,
): string[] => {
  if (sampleLimit <= 0) {
    return [];
  }

  const displays = new Set<string>();

  for (const entry of entries) {
    if (!entry.display) {
      continue;
    }

    displays.add(entry.display);
    if (displays.size >= sampleLimit) {
      break;
    }
  }

  return [...displays];
};

export const getSymbolCountMap = (
  entries: readonly NormalizedTypesTraceEntry[],
  filters: TraceFilterOptions,
): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    if (!pathPassesFilters(entry.declaration, filters)) {
      continue;
    }

    counts.set(entry.normalizedSymbolName, (counts.get(entry.normalizedSymbolName) ?? 0) + 1);
  }

  return counts;
};

export const getSymbolCounts = (
  entries: readonly NormalizedTypesTraceEntry[],
  filters: TraceFilterOptions,
): SymbolCount[] =>
  [...getSymbolCountMap(entries, filters).entries()]
    .map(([symbol, count]) => ({ symbol, count }))
    .sort(sortSymbolCounts);

export const analyzeFile = (
  entries: readonly NormalizedTypesTraceEntry[],
  file: string,
  options: {
    workspaceRoot: string;
    filters: TraceFilterOptions;
    sampleLimit: number;
  },
): FileAnalysisResult => {
  const query = normalizePathQuery(file, options.workspaceRoot);
  const matchingEntries = entries.filter(
    (entry) =>
      entry.declaration &&
      pathPassesFilters(entry.declaration, options.filters) &&
      pathMatchesQuery(entry.declaration, query),
  );

  const symbolEntries = new Map<string, NormalizedTypesTraceEntry[]>();
  for (const entry of matchingEntries) {
    const bucket = symbolEntries.get(entry.normalizedSymbolName) ?? [];
    bucket.push(entry);
    symbolEntries.set(entry.normalizedSymbolName, bucket);
  }

  const symbolCounts = [...symbolEntries.entries()]
    .map(([symbol, bucket]) => ({
      symbol,
      count: bucket.length,
      sampleDisplays: collectSampleDisplays(bucket, options.sampleLimit),
    }))
    .sort(sortSymbolCounts);

  const anonymousGroups = symbolCounts.filter((row) =>
    anonymousSymbolNames.includes(row.symbol as (typeof anonymousSymbolNames)[number]),
  );

  const rawSamples = matchingEntries.slice(0, options.sampleLimit).map((entry) => ({
    id: entry.id,
    symbol: entry.normalizedSymbolName,
    display: entry.display,
    declarationRange: formatDeclarationRange(entry),
  }));

  return {
    file: query.kind === "absolute" ? query.value : query.value,
    entryCount: matchingEntries.length,
    symbolCounts,
    anonymousGroups: anonymousGroups.map(({ symbol, count }) => ({ symbol, count })),
    rawSamples,
  };
};

const sortFileCounts = (left: SymbolFileCount, right: SymbolFileCount): number => {
  if (left.count !== right.count) {
    return right.count - left.count;
  }

  return left.file.localeCompare(right.file);
};

export const analyzeSymbol = (
  entries: readonly NormalizedTypesTraceEntry[],
  symbol: string,
  options: {
    filters: TraceFilterOptions;
    sampleLimit: number;
  },
): SymbolAnalysisResult => {
  const exactMatches = entries.filter(
    (entry) =>
      entry.normalizedSymbolName === symbol &&
      pathPassesFilters(entry.declaration, options.filters),
  );
  const matchingEntries =
    exactMatches.length > 0
      ? exactMatches
      : entries.filter(
          (entry) =>
            entry.normalizedSymbolName.toLowerCase() === symbol.toLowerCase() &&
            pathPassesFilters(entry.declaration, options.filters),
        );

  const declarationCounts = new Map<string, number>();
  for (const entry of matchingEntries) {
    if (!entry.declaration) {
      continue;
    }

    declarationCounts.set(
      entry.declaration.displayPath,
      (declarationCounts.get(entry.declaration.displayPath) ?? 0) + 1,
    );
  }

  return {
    symbol:
      exactMatches[0]?.normalizedSymbolName ?? matchingEntries[0]?.normalizedSymbolName ?? symbol,
    totalCount: matchingEntries.length,
    declarationFiles: [...declarationCounts.entries()]
      .map(([file, count]) => ({ file, count }))
      .sort(sortFileCounts),
    sampleDisplays: collectSampleDisplays(matchingEntries, options.sampleLimit),
  };
};
