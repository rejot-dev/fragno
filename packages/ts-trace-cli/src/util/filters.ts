import type { NormalizedTracePath } from "./paths.js";

export type TraceFilterOptions = {
  projectOnly: boolean;
  excludeNodeModules: boolean;
  excludeTypeScriptLibs: boolean;
  includePaths: string[];
  excludePaths: string[];
};

export const defaultProjectFilterOptions = (): TraceFilterOptions => ({
  projectOnly: true,
  excludeNodeModules: true,
  excludeTypeScriptLibs: true,
  includePaths: [],
  excludePaths: [],
});

export const defaultAllFilterOptions = (): TraceFilterOptions => ({
  projectOnly: false,
  excludeNodeModules: false,
  excludeTypeScriptLibs: false,
  includePaths: [],
  excludePaths: [],
});

const escapeRegularExpression = (value: string): string =>
  value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");

const patternToRegularExpression = (pattern: string): RegExp => {
  const normalizedPattern = pattern.replaceAll("\\", "/");
  const source = [...normalizedPattern]
    .map((character) => {
      if (character === "*") {
        return ".*";
      }

      if (character === "?") {
        return ".";
      }

      return escapeRegularExpression(character);
    })
    .join("");

  return new RegExp(`^${source}$`, "iu");
};

const pathMatchesPattern = (path: string, pattern: string): boolean => {
  const normalizedPath = path.toLowerCase();
  const normalizedPattern = pattern.replaceAll("\\", "/").toLowerCase();

  if (normalizedPattern.includes("*") || normalizedPattern.includes("?")) {
    return patternToRegularExpression(normalizedPattern).test(normalizedPath);
  }

  return normalizedPath.includes(normalizedPattern);
};

export const pathPassesFilters = (
  path: NormalizedTracePath | undefined,
  filters: TraceFilterOptions,
): boolean => {
  if (!path) {
    return !filters.projectOnly && filters.includePaths.length === 0;
  }

  if (filters.projectOnly && !path.isWithinWorkspace) {
    return false;
  }

  if (filters.excludeNodeModules && path.isNodeModules) {
    return false;
  }

  if (filters.excludeTypeScriptLibs && path.isTypeScriptLib) {
    return false;
  }

  if (
    filters.includePaths.length > 0 &&
    !filters.includePaths.some((pattern) => pathMatchesPattern(path.displayPath, pattern))
  ) {
    return false;
  }

  if (filters.excludePaths.some((pattern) => pathMatchesPattern(path.displayPath, pattern))) {
    return false;
  }

  return true;
};

export const mergeTraceFilterOptions = (
  base: TraceFilterOptions,
  overrides: Partial<TraceFilterOptions>,
): TraceFilterOptions => ({
  ...base,
  ...overrides,
  includePaths: overrides.includePaths ?? base.includePaths,
  excludePaths: overrides.excludePaths ?? base.excludePaths,
});
