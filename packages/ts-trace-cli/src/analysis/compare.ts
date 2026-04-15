import type { NormalizedTypesTraceEntry } from "../loaders/types-trace.js";
import type { TraceFilterOptions } from "../util/filters.js";
import { getFileCountMap } from "./files.js";
import { getSymbolCountMap } from "./symbols.js";

export type CountDelta = {
  name: string;
  beforeCount: number;
  afterCount: number;
  delta: number;
};

export type CompareAnalysisResult = {
  fileDeltas: CountDelta[];
  symbolDeltas: CountDelta[];
  biggestImprovements: {
    files: CountDelta[];
    symbols: CountDelta[];
  };
  biggestRegressions: {
    files: CountDelta[];
    symbols: CountDelta[];
  };
};

const sortCountDeltas = (left: CountDelta, right: CountDelta): number => {
  const leftMagnitude = Math.abs(left.delta);
  const rightMagnitude = Math.abs(right.delta);

  if (leftMagnitude !== rightMagnitude) {
    return rightMagnitude - leftMagnitude;
  }

  if (left.delta !== right.delta) {
    return left.delta - right.delta;
  }

  return left.name.localeCompare(right.name);
};

const buildCountDeltas = (
  beforeCounts: Map<string, number>,
  afterCounts: Map<string, number>,
): CountDelta[] => {
  const keys = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);

  return [...keys]
    .map((name) => {
      const beforeCount = beforeCounts.get(name) ?? 0;
      const afterCount = afterCounts.get(name) ?? 0;

      return {
        name,
        beforeCount,
        afterCount,
        delta: afterCount - beforeCount,
      };
    })
    .filter((row) => row.delta !== 0)
    .sort(sortCountDeltas);
};

const takeImprovements = (deltas: CountDelta[]): CountDelta[] =>
  deltas.filter((row) => row.delta < 0).sort((left, right) => left.delta - right.delta);

const takeRegressions = (deltas: CountDelta[]): CountDelta[] =>
  deltas.filter((row) => row.delta > 0).sort((left, right) => right.delta - left.delta);

export const compareTypesTraceEntries = (
  beforeEntries: readonly NormalizedTypesTraceEntry[],
  afterEntries: readonly NormalizedTypesTraceEntry[],
  filters: TraceFilterOptions,
): CompareAnalysisResult => {
  const fileDeltas = buildCountDeltas(
    getFileCountMap(beforeEntries, filters),
    getFileCountMap(afterEntries, filters),
  );
  const symbolDeltas = buildCountDeltas(
    getSymbolCountMap(beforeEntries, filters),
    getSymbolCountMap(afterEntries, filters),
  );

  return {
    fileDeltas,
    symbolDeltas,
    biggestImprovements: {
      files: takeImprovements(fileDeltas),
      symbols: takeImprovements(symbolDeltas),
    },
    biggestRegressions: {
      files: takeRegressions(fileDeltas),
      symbols: takeRegressions(symbolDeltas),
    },
  };
};
