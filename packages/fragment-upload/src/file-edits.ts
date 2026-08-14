/*
 * Portions adapted from Cloudflare Agents:
 * https://github.com/cloudflare/agents/blob/main/packages/shell/src/helpers.ts
 *
 * MIT License
 * Copyright (c) 2025 Cloudflare, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

export const MAX_FILE_EDIT_DIFF_LINES = 10_000;

export type FileEditSearchOptions = {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  maxMatches?: number;
};

export type FileEditOperation =
  | { kind: "write"; fileKey: string; content: string }
  | {
      kind: "replace";
      fileKey: string;
      search: string;
      replacement: string;
      options?: FileEditSearchOptions;
    }
  | {
      kind: "writeJson";
      fileKey: string;
      value: unknown;
      options?: { spaces?: number };
    };

export type AppliedFileEdit = {
  fileKey: string;
  changed: boolean;
  content: string;
  diff: string;
};

export type ApplyFileEditsInput = {
  provider: string;
  edits: FileEditOperation[];
};

export type ApplyFileEditsResult = {
  edits: AppliedFileEdit[];
  totalChanged: number;
};

export class FileEditError extends Error {}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function createTextMatcher(query: string, options: FileEditSearchOptions): RegExp {
  if (query.length === 0) {
    throw new FileEditError("Search query must not be empty.");
  }

  let source = options.regex ? query : escapeRegExp(query);
  if (options.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }

  try {
    return new RegExp(source, options.caseSensitive === false ? "gi" : "g");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new FileEditError(`Invalid search pattern: ${message}`);
  }
}

export function replaceTextContent(
  content: string,
  search: string,
  replacement: string,
  options: FileEditSearchOptions = {},
): { content: string; replaced: number } {
  const matcher = createTextMatcher(search, options);
  const maxMatches = options.maxMatches ?? Number.POSITIVE_INFINITY;
  let replaced = 0;
  const nextContent = content.replace(matcher, (match) => {
    if (replaced >= maxMatches) {
      return match;
    }
    replaced += 1;
    return replacement;
  });
  return { content: nextContent, replaced };
}

export function stringifyJsonFileContent(value: unknown, fileKey: string, spaces = 2): string {
  const serialized = JSON.stringify(value, null, spaces);
  if (serialized === undefined) {
    throw new FileEditError(`Unable to serialize JSON for ${fileKey}.`);
  }
  return `${serialized}\n`;
}

export function applyFileEditOperation(
  currentContent: string | null,
  operation: FileEditOperation,
): string {
  if (operation.kind === "write") {
    return operation.content;
  }
  if (operation.kind === "writeJson") {
    return stringifyJsonFileContent(operation.value, operation.fileKey, operation.options?.spaces);
  }
  if (currentContent === null) {
    throw new FileEditError(`Cannot replace text in missing file '${operation.fileKey}'.`);
  }
  return replaceTextContent(
    currentContent,
    operation.search,
    operation.replacement,
    operation.options,
  ).content;
}

type DiffEdit = { type: "keep" | "delete" | "insert"; lineA: number; lineB: number };

function myersDiff(before: string[], after: string[]): DiffEdit[] {
  const n = before.length;
  const m = after.length;
  const max = n + m;
  const offset = max;
  const vector = new Int32Array(2 * max + 1);
  vector.fill(-1);
  vector[offset + 1] = 0;
  const trace: Int32Array[] = [];

  outer: for (let distance = 0; distance <= max; distance++) {
    trace.push(vector.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x: number;
      if (
        diagonal === -distance ||
        (diagonal !== distance && vector[offset + diagonal - 1] < vector[offset + diagonal + 1])
      ) {
        x = vector[offset + diagonal + 1];
      } else {
        x = vector[offset + diagonal - 1] + 1;
      }
      let y = x - diagonal;
      while (x < n && y < m && before[x] === after[y]) {
        x++;
        y++;
      }
      vector[offset + diagonal] = x;
      if (x >= n && y >= m) {
        break outer;
      }
    }
  }

  const edits: DiffEdit[] = [];
  let x = n;
  let y = m;
  for (let distance = trace.length - 1; distance >= 0; distance--) {
    const previous = trace[distance];
    const diagonal = x - y;
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance && previous[offset + diagonal - 1] < previous[offset + diagonal + 1])
        ? diagonal + 1
        : diagonal - 1;
    const previousX = previous[offset + previousDiagonal];
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      x--;
      y--;
      edits.push({ type: "keep", lineA: x, lineB: y });
    }
    if (distance > 0) {
      if (x === previousX) {
        edits.push({ type: "insert", lineA: x, lineB: y - 1 });
        y--;
      } else {
        edits.push({ type: "delete", lineA: x - 1, lineB: y });
        x--;
      }
    }
  }
  return edits.reverse();
}

function formatUnifiedDiff(
  edits: DiffEdit[],
  before: string[],
  after: string[],
  labelBefore: string,
  labelAfter: string,
  contextLines = 3,
): string {
  const output = [`--- ${labelBefore}`, `+++ ${labelAfter}`];
  const changes = edits.flatMap((edit, index) => (edit.type === "keep" ? [] : [index]));
  if (changes.length === 0) {
    return "";
  }

  let changeIndex = 0;
  while (changeIndex < changes.length) {
    const start = Math.max(0, changes[changeIndex] - contextLines);
    let end = Math.min(edits.length - 1, changes[changeIndex] + contextLines);
    let nextChange = changeIndex + 1;
    while (nextChange < changes.length && changes[nextChange] - contextLines <= end + 1) {
      end = Math.min(edits.length - 1, changes[nextChange] + contextLines);
      nextChange++;
    }

    const hunk: string[] = [];
    let countBefore = 0;
    let countAfter = 0;
    for (let index = start; index <= end; index++) {
      const edit = edits[index];
      if (edit.type === "keep") {
        hunk.push(` ${before[edit.lineA]}`);
        countBefore++;
        countAfter++;
      } else if (edit.type === "delete") {
        hunk.push(`-${before[edit.lineA]}`);
        countBefore++;
      } else {
        hunk.push(`+${after[edit.lineB]}`);
        countAfter++;
      }
    }
    output.push(
      `@@ -${edits[start].lineA + 1},${countBefore} +${edits[start].lineB + 1},${countAfter} @@`,
      ...hunk,
    );
    changeIndex = nextChange;
  }
  return output.join("\n");
}

export function diffContent(
  current: string,
  next: string,
  labelBefore: string,
  labelAfter: string,
): string {
  if (current === next) {
    return "";
  }
  const before = current.split("\n");
  const after = next.split("\n");
  if (before.length > MAX_FILE_EDIT_DIFF_LINES || after.length > MAX_FILE_EDIT_DIFF_LINES) {
    throw new FileEditError(
      `Content is too large for a diff (maximum ${MAX_FILE_EDIT_DIFF_LINES} lines).`,
    );
  }
  return formatUnifiedDiff(myersDiff(before, after), before, after, labelBefore, labelAfter);
}
