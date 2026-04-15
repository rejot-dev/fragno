#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareTypesTraceEntries } from "./analysis/compare.js";
import { getFileCounts } from "./analysis/files.js";
import { analyzeFile, analyzeSymbol, getSymbolCounts } from "./analysis/symbols.js";
import { formatJson } from "./formatters/json.js";
import {
  formatBulletList,
  formatKeyValueBlock,
  formatSection,
  formatTable,
} from "./formatters/table.js";
import { loadTypesTrace } from "./loaders/types-trace.js";
import {
  defaultAllFilterOptions,
  defaultProjectFilterOptions,
  mergeTraceFilterOptions,
  type TraceFilterOptions,
} from "./util/filters.js";
import { resolveWorkspaceRoot } from "./util/paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as {
  version: string;
};

const VERSION = packageJson.version;
const DEFAULT_LIMIT = 10;
const DEFAULT_SAMPLES = 5;

type CliLogger = {
  log: (message: string) => void;
  error: (message: string) => void;
};

type ParsedCliOptions = {
  format: "table" | "json";
  limit: number;
  samples: number;
  includePaths: string[];
  excludePaths: string[];
  workspaceRoot?: string;
  all: boolean;
  projectOnly: boolean;
  includeNodeModules: boolean;
  includeTypeScriptLibs: boolean;
};

type ParseCommandResult = {
  positionals: string[];
  options: ParsedCliOptions;
};

type RunContext = {
  logger?: CliLogger;
};

const COUNT_HELP =
  "Count means the number of matching entries in types.json, not checker time or milliseconds.";

const USAGE = `TypeScript trace analysis CLI

USAGE:
  ts-trace <command> [arguments] [options]

COMMANDS:
  summary <traceDir>                  Summarize top files and symbols
  file <traceDir> <file>             Show the hottest symbols declared in one file
  symbol <traceDir> <symbol>         Show counts, files, and sample displays for one symbol
  compare <beforeTraceDir> <afterTraceDir>
                                     Compare file and symbol counts between traces

OPTIONS:
  --format <table|json>              Output format (default: table)
  --limit <n>                        Maximum rows per table (default: 10)
  --samples <n>                      Sample display/raw rows to include (default: 5)
  --workspace-root <path>            Override workspace root for path normalization
  --include <pattern>                Include only matching paths (repeatable)
  --exclude <pattern>                Exclude matching paths (repeatable)
  --all                              Include all paths, including node_modules and TS libs
  --project-only                     Restrict output to project-local paths
  --include-node-modules             Keep node_modules paths in project-local mode
  --include-ts-libs                  Keep TypeScript lib files in project-local mode
  -h, --help                         Show help
  -v, --version                      Show version

NOTES:
  ${COUNT_HELP}`;

const SUMMARY_USAGE = `USAGE:
  ts-trace summary <traceDir> [options]

NOTE:
  ${COUNT_HELP}`;

const FILE_USAGE = `USAGE:
  ts-trace file <traceDir> <file> [options]

NOTE:
  ${COUNT_HELP}`;

const SYMBOL_USAGE = `USAGE:
  ts-trace symbol <traceDir> <symbol> [options]

NOTE:
  ${COUNT_HELP}`;

const COMPARE_USAGE = `USAGE:
  ts-trace compare <beforeTraceDir> <afterTraceDir> [options]

NOTE:
  ${COUNT_HELP}`;

const createLogger = (logger?: CliLogger): CliLogger =>
  logger ?? {
    log: (message: string) => console.log(message),
    error: (message: string) => console.error(message),
  };

const sliceLimit = <T>(values: T[], limit: number): T[] => values.slice(0, Math.max(0, limit));

const formatDelta = (value: number): string => (value > 0 ? `+${value}` : `${value}`);

const parseIntegerOption = (name: string, value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${name}: ${value}`);
  }

  return parsed;
};

const createDefaultOptions = (): ParsedCliOptions => ({
  format: "table",
  limit: DEFAULT_LIMIT,
  samples: DEFAULT_SAMPLES,
  includePaths: [],
  excludePaths: [],
  workspaceRoot: undefined,
  all: false,
  projectOnly: false,
  includeNodeModules: false,
  includeTypeScriptLibs: false,
});

const parseCommandArguments = (args: string[]): ParseCommandResult => {
  const positionals: string[] = [];
  const options = createDefaultOptions();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (!token) {
      continue;
    }

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    if (token === "--format") {
      const value = args[index + 1];
      if (value !== "table" && value !== "json") {
        throw new Error(`Invalid value for --format: ${value ?? "(missing)"}`);
      }
      options.format = value;
      index += 1;
      continue;
    }

    if (token === "--limit") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --limit");
      }
      options.limit = parseIntegerOption("--limit", value);
      index += 1;
      continue;
    }

    if (token === "--samples") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --samples");
      }
      options.samples = parseIntegerOption("--samples", value);
      index += 1;
      continue;
    }

    if (token === "--workspace-root") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --workspace-root");
      }
      options.workspaceRoot = value;
      index += 1;
      continue;
    }

    if (token === "--include") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --include");
      }
      options.includePaths.push(value);
      index += 1;
      continue;
    }

    if (token === "--exclude") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --exclude");
      }
      options.excludePaths.push(value);
      index += 1;
      continue;
    }

    if (token === "--all") {
      options.all = true;
      continue;
    }

    if (token === "--project-only") {
      options.projectOnly = true;
      continue;
    }

    if (token === "--include-node-modules") {
      options.includeNodeModules = true;
      continue;
    }

    if (token === "--include-ts-libs") {
      options.includeTypeScriptLibs = true;
      continue;
    }

    throw new Error(`Unknown option: ${token}`);
  }

  if (options.all && options.projectOnly) {
    throw new Error("--all and --project-only cannot be used together.");
  }

  return { positionals, options };
};

const buildProjectFilters = (options: ParsedCliOptions): TraceFilterOptions =>
  mergeTraceFilterOptions(defaultProjectFilterOptions(), {
    excludeNodeModules: !options.includeNodeModules,
    excludeTypeScriptLibs: !options.includeTypeScriptLibs,
    includePaths: options.includePaths,
    excludePaths: options.excludePaths,
  });

const buildAllFilters = (options: ParsedCliOptions): TraceFilterOptions =>
  mergeTraceFilterOptions(defaultAllFilterOptions(), {
    includePaths: options.includePaths,
    excludePaths: options.excludePaths,
  });

const buildActiveFilters = (options: ParsedCliOptions): TraceFilterOptions =>
  options.all ? buildAllFilters(options) : buildProjectFilters(options);

const renderSummaryTable = (result: {
  traceDir: string;
  workspaceRoot: string;
  entryCount: number;
  projectEntryCount: number;
  overallFiles: Array<{ file: string; count: number }>;
  overallSymbols: Array<{ symbol: string; count: number }>;
  projectLocalFiles: Array<{ file: string; count: number }>;
  projectLocalSymbols: Array<{ symbol: string; count: number }>;
  limit: number;
}): string => {
  const sections = [
    formatSection(
      "Trace summary",
      formatKeyValueBlock([
        ["Trace dir", result.traceDir],
        ["Workspace root", result.workspaceRoot],
        ["Total entries", result.entryCount],
        ["Project-local entries", result.projectEntryCount],
      ]),
    ),
    formatSection(
      "Top project-local files",
      formatTable(
        [
          { label: "Count", value: (row: { count: number }) => row.count, align: "right" },
          {
            label: "File",
            value: (row: { file: string }) => row.file,
            maxWidth: 100,
          },
        ],
        sliceLimit(result.projectLocalFiles, result.limit),
      ),
    ),
    formatSection(
      "Top project-local symbols",
      formatTable(
        [
          { label: "Count", value: (row: { count: number }) => row.count, align: "right" },
          {
            label: "Symbol",
            value: (row: { symbol: string }) => row.symbol,
            maxWidth: 60,
          },
        ],
        sliceLimit(result.projectLocalSymbols, result.limit),
      ),
    ),
    formatSection(
      "Top files (all)",
      formatTable(
        [
          { label: "Count", value: (row: { count: number }) => row.count, align: "right" },
          {
            label: "File",
            value: (row: { file: string }) => row.file,
            maxWidth: 100,
          },
        ],
        sliceLimit(result.overallFiles, result.limit),
      ),
    ),
    formatSection(
      "Top symbols (all)",
      formatTable(
        [
          { label: "Count", value: (row: { count: number }) => row.count, align: "right" },
          {
            label: "Symbol",
            value: (row: { symbol: string }) => row.symbol,
            maxWidth: 60,
          },
        ],
        sliceLimit(result.overallSymbols, result.limit),
      ),
    ),
  ];

  return `${sections.join("\n\n")}\n`;
};

const renderFileTable = (result: {
  traceDir: string;
  file: string;
  entryCount: number;
  symbolCounts: Array<{ symbol: string; count: number; sampleDisplays: string[] }>;
  anonymousGroups: Array<{ symbol: string; count: number }>;
  rawSamples: Array<{ id: number; symbol: string; display?: string; declarationRange?: string }>;
  limit: number;
}): string => {
  const sections = [
    formatSection(
      "File summary",
      formatKeyValueBlock([
        ["Trace dir", result.traceDir],
        ["File", result.file],
        ["Matched entries", result.entryCount],
      ]),
    ),
    formatSection(
      "Top symbols",
      formatTable(
        [
          { label: "Count", value: (row: { count: number }) => row.count, align: "right" },
          {
            label: "Symbol",
            value: (row: { symbol: string }) => row.symbol,
            maxWidth: 40,
          },
          {
            label: "Sample display",
            value: (row: { sampleDisplays: string[] }) => row.sampleDisplays[0] ?? "",
            maxWidth: 80,
          },
        ],
        sliceLimit(result.symbolCounts, result.limit),
      ),
    ),
    formatSection(
      "Anonymous groups",
      formatTable(
        [
          { label: "Count", value: (row: { count: number }) => row.count, align: "right" },
          { label: "Group", value: (row: { symbol: string }) => row.symbol, maxWidth: 30 },
        ],
        result.anonymousGroups,
      ),
    ),
    formatSection(
      "Raw samples",
      formatTable(
        [
          { label: "ID", value: (row: { id: number }) => row.id, align: "right" },
          { label: "Symbol", value: (row: { symbol: string }) => row.symbol, maxWidth: 30 },
          {
            label: "Range",
            value: (row: { declarationRange?: string }) => row.declarationRange ?? "",
            maxWidth: 20,
          },
          {
            label: "Display",
            value: (row: { display?: string }) => row.display ?? "",
            maxWidth: 80,
          },
        ],
        result.rawSamples,
      ),
    ),
  ];

  return `${sections.join("\n\n")}\n`;
};

const renderSymbolTable = (result: {
  traceDir: string;
  symbol: string;
  totalCount: number;
  declarationFiles: Array<{ file: string; count: number }>;
  sampleDisplays: string[];
  limit: number;
}): string => {
  const sections = [
    formatSection(
      "Symbol summary",
      formatKeyValueBlock([
        ["Trace dir", result.traceDir],
        ["Symbol", result.symbol],
        ["Total count", result.totalCount],
      ]),
    ),
    formatSection(
      "Declaration files",
      formatTable(
        [
          { label: "Count", value: (row: { count: number }) => row.count, align: "right" },
          { label: "File", value: (row: { file: string }) => row.file, maxWidth: 100 },
        ],
        sliceLimit(result.declarationFiles, result.limit),
      ),
    ),
    formatBulletList("Sample displays", result.sampleDisplays),
  ];

  return `${sections.join("\n\n")}\n`;
};

const renderCompareTable = (result: {
  beforeTraceDir: string;
  afterTraceDir: string;
  scope: "project" | "all";
  fileDeltas: Array<{ file: string; beforeCount: number; afterCount: number; delta: number }>;
  symbolDeltas: Array<{ symbol: string; beforeCount: number; afterCount: number; delta: number }>;
  biggestImprovements: {
    files: Array<{ file: string; beforeCount: number; afterCount: number; delta: number }>;
    symbols: Array<{ symbol: string; beforeCount: number; afterCount: number; delta: number }>;
  };
  biggestRegressions: {
    files: Array<{ file: string; beforeCount: number; afterCount: number; delta: number }>;
    symbols: Array<{ symbol: string; beforeCount: number; afterCount: number; delta: number }>;
  };
  limit: number;
}): string => {
  const deltaColumns = [
    {
      label: "Before",
      value: (row: { beforeCount: number }) => row.beforeCount,
      align: "right" as const,
    },
    {
      label: "After",
      value: (row: { afterCount: number }) => row.afterCount,
      align: "right" as const,
    },
    {
      label: "Delta",
      value: (row: { delta: number }) => formatDelta(row.delta),
      align: "right" as const,
    },
  ];

  const sections = [
    formatSection(
      "Trace comparison",
      formatKeyValueBlock([
        ["Before", result.beforeTraceDir],
        ["After", result.afterTraceDir],
        ["Scope", result.scope === "all" ? "all paths" : "project-local"],
      ]),
    ),
    formatSection(
      "Biggest file improvements",
      formatTable(
        [
          { label: "File", value: (row: { file: string }) => row.file, maxWidth: 100 },
          ...deltaColumns,
        ],
        sliceLimit(result.biggestImprovements.files, result.limit),
      ),
    ),
    formatSection(
      "Biggest file regressions",
      formatTable(
        [
          { label: "File", value: (row: { file: string }) => row.file, maxWidth: 100 },
          ...deltaColumns,
        ],
        sliceLimit(result.biggestRegressions.files, result.limit),
      ),
    ),
    formatSection(
      "Biggest symbol improvements",
      formatTable(
        [
          { label: "Symbol", value: (row: { symbol: string }) => row.symbol, maxWidth: 50 },
          ...deltaColumns,
        ],
        sliceLimit(result.biggestImprovements.symbols, result.limit),
      ),
    ),
    formatSection(
      "Biggest symbol regressions",
      formatTable(
        [
          { label: "Symbol", value: (row: { symbol: string }) => row.symbol, maxWidth: 50 },
          ...deltaColumns,
        ],
        sliceLimit(result.biggestRegressions.symbols, result.limit),
      ),
    ),
    formatSection(
      "File deltas",
      formatTable(
        [
          { label: "File", value: (row: { file: string }) => row.file, maxWidth: 100 },
          ...deltaColumns,
        ],
        sliceLimit(result.fileDeltas, result.limit),
      ),
    ),
    formatSection(
      "Symbol deltas",
      formatTable(
        [
          { label: "Symbol", value: (row: { symbol: string }) => row.symbol, maxWidth: 50 },
          ...deltaColumns,
        ],
        sliceLimit(result.symbolDeltas, result.limit),
      ),
    ),
  ];

  return `${sections.join("\n\n")}\n`;
};

const buildSummaryOutput = (traceDir: string, options: ParsedCliOptions) => {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const trace = loadTypesTrace(traceDir, { workspaceRoot });
  const allFilters = buildAllFilters(options);
  const projectFilters = buildProjectFilters(options);
  const overallFiles = getFileCounts(trace.entries, allFilters);
  const overallSymbols = getSymbolCounts(trace.entries, allFilters);
  const projectLocalFiles = getFileCounts(trace.entries, projectFilters);
  const projectLocalSymbols = getSymbolCounts(trace.entries, projectFilters);

  return {
    command: "summary" as const,
    traceDir,
    workspaceRoot,
    entryCount: trace.entryCount,
    projectEntryCount: projectLocalSymbols.reduce((total, row) => total + row.count, 0),
    overallFiles,
    overallSymbols,
    projectLocalFiles,
    projectLocalSymbols,
    limit: options.limit,
  };
};

const buildFileOutput = (traceDir: string, file: string, options: ParsedCliOptions) => {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const trace = loadTypesTrace(traceDir, { workspaceRoot });
  const analysis = analyzeFile(trace.entries, file, {
    workspaceRoot,
    filters: buildActiveFilters(options),
    sampleLimit: options.samples,
  });

  return {
    command: "file" as const,
    traceDir,
    workspaceRoot,
    file,
    entryCount: analysis.entryCount,
    symbolCounts: analysis.symbolCounts,
    anonymousGroups: analysis.anonymousGroups,
    rawSamples: analysis.rawSamples,
    limit: options.limit,
  };
};

const buildSymbolOutput = (traceDir: string, symbol: string, options: ParsedCliOptions) => {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const trace = loadTypesTrace(traceDir, { workspaceRoot });
  const analysis = analyzeSymbol(trace.entries, symbol, {
    filters: buildActiveFilters(options),
    sampleLimit: options.samples,
  });

  return {
    command: "symbol" as const,
    traceDir,
    workspaceRoot,
    symbol: analysis.symbol,
    totalCount: analysis.totalCount,
    declarationFiles: analysis.declarationFiles,
    sampleDisplays: analysis.sampleDisplays,
    limit: options.limit,
  };
};

const mapNamedDeltas = <TName extends string>(
  deltas: Array<{ name: string; beforeCount: number; afterCount: number; delta: number }>,
  key: TName,
): Array<Record<TName, string> & { beforeCount: number; afterCount: number; delta: number }> =>
  deltas.map((row) => ({
    [key]: row.name,
    beforeCount: row.beforeCount,
    afterCount: row.afterCount,
    delta: row.delta,
  })) as Array<Record<TName, string> & { beforeCount: number; afterCount: number; delta: number }>;

const buildCompareOutput = (
  beforeTraceDir: string,
  afterTraceDir: string,
  options: ParsedCliOptions,
) => {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const beforeTrace = loadTypesTrace(beforeTraceDir, { workspaceRoot });
  const afterTrace = loadTypesTrace(afterTraceDir, { workspaceRoot });
  const filters = buildActiveFilters(options);
  const comparison = compareTypesTraceEntries(beforeTrace.entries, afterTrace.entries, filters);

  return {
    command: "compare" as const,
    beforeTraceDir,
    afterTraceDir,
    workspaceRoot,
    scope: options.all ? ("all" as const) : ("project" as const),
    fileDeltas: mapNamedDeltas(comparison.fileDeltas, "file"),
    symbolDeltas: mapNamedDeltas(comparison.symbolDeltas, "symbol"),
    biggestImprovements: {
      files: mapNamedDeltas(comparison.biggestImprovements.files, "file"),
      symbols: mapNamedDeltas(comparison.biggestImprovements.symbols, "symbol"),
    },
    biggestRegressions: {
      files: mapNamedDeltas(comparison.biggestRegressions.files, "file"),
      symbols: mapNamedDeltas(comparison.biggestRegressions.symbols, "symbol"),
    },
    limit: options.limit,
  };
};

const renderOutput = (
  result:
    | ReturnType<typeof buildSummaryOutput>
    | ReturnType<typeof buildFileOutput>
    | ReturnType<typeof buildSymbolOutput>
    | ReturnType<typeof buildCompareOutput>,
  options: ParsedCliOptions,
): string => {
  if (options.format === "json") {
    return formatJson(result);
  }

  if (result.command === "summary") {
    return renderSummaryTable(result);
  }

  if (result.command === "file") {
    return renderFileTable(result);
  }

  if (result.command === "symbol") {
    return renderSymbolTable(result);
  }

  return renderCompareTable(result);
};

export async function run(argv = process.argv, context: RunContext = {}): Promise<number> {
  const logger = createLogger(context.logger);
  const args = argv.slice(2);

  try {
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
      logger.log(USAGE);
      return 0;
    }

    if (args[0] === "--version" || args[0] === "-v") {
      logger.log(VERSION);
      return 0;
    }

    const [command, ...rest] = args;

    if (rest[0] === "--help" || rest[0] === "-h") {
      logger.log(
        command === "summary"
          ? SUMMARY_USAGE
          : command === "file"
            ? FILE_USAGE
            : command === "symbol"
              ? SYMBOL_USAGE
              : command === "compare"
                ? COMPARE_USAGE
                : USAGE,
      );
      return command === "summary" ||
        command === "file" ||
        command === "symbol" ||
        command === "compare"
        ? 0
        : 1;
    }

    const parsed = parseCommandArguments(rest);

    if (command === "summary") {
      const [traceDir] = parsed.positionals;
      if (!traceDir) {
        throw new Error(SUMMARY_USAGE);
      }
      logger.log(renderOutput(buildSummaryOutput(traceDir, parsed.options), parsed.options));
      return 0;
    }

    if (command === "file") {
      const [traceDir, file] = parsed.positionals;
      if (!traceDir || !file) {
        throw new Error(FILE_USAGE);
      }
      logger.log(renderOutput(buildFileOutput(traceDir, file, parsed.options), parsed.options));
      return 0;
    }

    if (command === "symbol") {
      const [traceDir, symbol] = parsed.positionals;
      if (!traceDir || !symbol) {
        throw new Error(SYMBOL_USAGE);
      }
      logger.log(renderOutput(buildSymbolOutput(traceDir, symbol, parsed.options), parsed.options));
      return 0;
    }

    if (command === "compare") {
      const [beforeTraceDir, afterTraceDir] = parsed.positionals;
      if (!beforeTraceDir || !afterTraceDir) {
        throw new Error(COMPARE_USAGE);
      }
      logger.log(
        renderOutput(
          buildCompareOutput(beforeTraceDir, afterTraceDir, parsed.options),
          parsed.options,
        ),
      );
      return 0;
    }

    logger.error(`Unknown command: ${command}`);
    logger.log(USAGE);
    return 1;
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  process.exitCode = await run(process.argv);
}

export const __testing = {
  USAGE,
  SUMMARY_USAGE,
  FILE_USAGE,
  SYMBOL_USAGE,
  COMPARE_USAGE,
  parseCommandArguments,
};
