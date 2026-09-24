import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";

export type HeapProfileCallFrame = {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type HeapProfileFrame = {
  functionName: string;
  file: string;
  line: number;
  column: number;
  kind: "project" | "dependency" | "runtime";
};

function displayFrameFile(file: string, repositoryRoot: string): string {
  const relative = path.relative(repositoryRoot, file);
  return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative;
}

function frameKind(file: string, repositoryRoot: string): HeapProfileFrame["kind"] {
  const relative = path.relative(repositoryRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return file.includes("node_modules/") ? "dependency" : "runtime";
  }
  return relative.includes("node_modules/") ? "dependency" : "project";
}

/** Resolve V8's generated, zero-based frame positions into source-mapped repository locations. */
export function createHeapProfileSourceResolver(repositoryRoot: string) {
  const maps = new Map<string, TraceMap | null>();
  const frames = new Map<string, HeapProfileFrame>();
  return function resolveHeapProfileFrame(frame: HeapProfileCallFrame): HeapProfileFrame {
    const cacheKey = `${frame.url}\0${frame.lineNumber}\0${frame.columnNumber}\0${frame.functionName}`;
    const cached = frames.get(cacheKey);
    if (cached) {
      return cached;
    }
    if (!frame.url.startsWith("file://")) {
      const resolved = {
        functionName: frame.functionName,
        file: frame.url || "(native/anonymous)",
        line: frame.lineNumber + 1,
        column: frame.columnNumber + 1,
        kind: "runtime" as const,
      };
      frames.set(cacheKey, resolved);
      return resolved;
    }

    const compiledFile = fileURLToPath(frame.url);
    let sourceFile = compiledFile;
    let line = frame.lineNumber + 1;
    let column = frame.columnNumber + 1;
    const mapPath = `${compiledFile}.map`;
    if (frameKind(compiledFile, repositoryRoot) === "project") {
      let map = maps.get(mapPath);
      if (map === undefined) {
        map = existsSync(mapPath)
          ? new TraceMap(
              JSON.parse(readFileSync(mapPath, "utf8")) as SourceMapInput,
              pathToFileURL(mapPath).href,
            )
          : null;
        maps.set(mapPath, map);
      }
      if (map && frame.lineNumber >= 0 && frame.columnNumber >= 0) {
        const original = originalPositionFor(map, {
          line: frame.lineNumber + 1,
          column: frame.columnNumber,
        });
        if (original.source !== null && original.line !== null && original.column !== null) {
          sourceFile = original.source.startsWith("file://")
            ? fileURLToPath(original.source)
            : path.resolve(path.dirname(mapPath), original.source);
          line = original.line;
          column = original.column + 1;
        }
      }
    }
    const resolved = {
      functionName: frame.functionName,
      file: displayFrameFile(sourceFile, repositoryRoot),
      line,
      column,
      kind: frameKind(sourceFile, repositoryRoot),
    };
    frames.set(cacheKey, resolved);
    return resolved;
  };
}
