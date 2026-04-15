export {
  compareTypesTraceEntries,
  type CompareAnalysisResult,
  type CountDelta,
} from "./analysis/compare.js";
export { getFileCountMap, getFileCounts, type FileCount } from "./analysis/files.js";
export {
  analyzeFile,
  analyzeSymbol,
  anonymousSymbolNames,
  getSymbolCountMap,
  getSymbolCounts,
  type FileAnalysisResult,
  type RawFileSample,
  type SymbolAnalysisResult,
  type SymbolCount,
  type SymbolFileCount,
  type SymbolSummary,
} from "./analysis/symbols.js";
export { run, __testing } from "./cli.js";
export { formatJson } from "./formatters/json.js";
export {
  formatBulletList,
  formatKeyValueBlock,
  formatSection,
  formatTable,
  type TableColumn,
} from "./formatters/table.js";
export {
  loadEventTrace,
  type EventTraceLoadResult,
  type EventTraceRawEvent,
  type NormalizedEventTraceEvent,
} from "./loaders/event-trace.js";
export {
  loadTypesTrace,
  normalizeTypesTraceEntry,
  type NormalizedTypeDeclaration,
  type NormalizedTypesTraceEntry,
  type TraceSourcePosition,
  type TypesTraceLoadResult,
  type TypesTraceRawEntry,
} from "./loaders/types-trace.js";
export {
  defaultAllFilterOptions,
  defaultProjectFilterOptions,
  mergeTraceFilterOptions,
  pathPassesFilters,
  type TraceFilterOptions,
} from "./util/filters.js";
export {
  findWorkspaceRoot,
  normalizePathQuery,
  normalizeTracePath,
  pathMatchesQuery,
  resolveWorkspaceRoot,
  type NormalizedTracePath,
  type PathQuery,
} from "./util/paths.js";
