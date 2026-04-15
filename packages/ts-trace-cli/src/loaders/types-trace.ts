import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeTracePath,
  resolveWorkspaceRoot,
  type NormalizedTracePath,
} from "../util/paths.js";

export type TraceSourcePosition = {
  line: number;
  character: number;
};

export type TypesTraceRawEntry = {
  id: number;
  symbolName?: string;
  intrinsicName?: string;
  flags?: string[];
  display?: string;
  firstDeclaration?: {
    path: string;
    start?: TraceSourcePosition;
    end?: TraceSourcePosition;
  };
  [key: string]: unknown;
};

export type NormalizedTypeDeclaration = NormalizedTracePath & {
  start?: TraceSourcePosition;
  end?: TraceSourcePosition;
};

export type NormalizedTypesTraceEntry = {
  id: number;
  symbolName?: string;
  intrinsicName?: string;
  normalizedSymbolName: string;
  display?: string;
  flags: string[];
  declaration?: NormalizedTypeDeclaration;
};

export type TypesTraceLoadResult = {
  traceDir: string;
  filePath: string;
  workspaceRoot: string;
  entryCount: number;
  entries: NormalizedTypesTraceEntry[];
};

const normalizeDeclaration = (
  entry: TypesTraceRawEntry,
  workspaceRoot: string,
): NormalizedTypeDeclaration | undefined => {
  if (!entry.firstDeclaration?.path) {
    return undefined;
  }

  return {
    ...normalizeTracePath(entry.firstDeclaration.path, workspaceRoot),
    start: entry.firstDeclaration.start,
    end: entry.firstDeclaration.end,
  };
};

export const normalizeTypesTraceEntry = (
  entry: TypesTraceRawEntry,
  workspaceRoot: string,
): NormalizedTypesTraceEntry => ({
  id: entry.id,
  symbolName: entry.symbolName,
  intrinsicName: entry.intrinsicName,
  normalizedSymbolName: entry.symbolName ?? entry.intrinsicName ?? "(anonymous)",
  display: entry.display,
  flags: entry.flags ?? [],
  declaration: normalizeDeclaration(entry, workspaceRoot),
});

export const loadTypesTrace = (
  traceDir: string,
  options?: {
    workspaceRoot?: string;
  },
): TypesTraceLoadResult => {
  const workspaceRoot = resolveWorkspaceRoot(options?.workspaceRoot);
  const filePath = join(traceDir, "types.json");
  const rawValue = JSON.parse(readFileSync(filePath, "utf8")) as unknown;

  if (!Array.isArray(rawValue)) {
    throw new Error(`Expected ${filePath} to contain a JSON array.`);
  }

  const entries = rawValue.map((value) =>
    normalizeTypesTraceEntry(value as TypesTraceRawEntry, workspaceRoot),
  );

  return {
    traceDir,
    filePath,
    workspaceRoot,
    entryCount: entries.length,
    entries,
  };
};
