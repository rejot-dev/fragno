import type { SourcePosition, SourceRange } from "./model.ts";
import type { PositionedWorkflowToken } from "./state-machine.ts";

export function sourceRangeFromToken(path: string, token: PositionedWorkflowToken): SourceRange {
  return {
    path,
    start: sourcePositionAtTokenStart(token),
    end: sourcePositionAtTokenEnd(token),
  };
}

export function sourceRangeAtOffset(path: string, source: string, offset: number): SourceRange {
  const position = sourcePositionAtOffset(source, offset);
  return { path, start: position, end: { ...position } };
}

export function sourcePositionAtTokenStart(token: PositionedWorkflowToken): SourcePosition {
  return { offset: token.start, line: token.line, column: token.column };
}

export function sourcePositionAtTokenEnd(token: PositionedWorkflowToken): SourcePosition {
  return { offset: token.end, line: token.endLine, column: token.endColumn };
}

export function sourcePositionAtOffset(source: string, offset: number): SourcePosition {
  const before = source.slice(0, offset);
  const lines = before.split(/\r\n|[\n\r\u2028\u2029]/u);
  return {
    offset,
    line: lines.length,
    column: lines.at(-1)?.length ?? 0,
  };
}

export function extendSourceRangeToToken(range: SourceRange, token: PositionedWorkflowToken): void {
  range.end = sourcePositionAtTokenEnd(token);
}

export function endSourceRangeAtTokenStart(
  range: SourceRange,
  token: PositionedWorkflowToken,
): void {
  range.end = sourcePositionAtTokenStart(token);
}

export function extendSourceRangeToRange(range: SourceRange, completedRange: SourceRange): void {
  range.end = { ...completedRange.end };
}

export function cloneSourceRange(range: SourceRange): SourceRange {
  return {
    path: range.path,
    start: { ...range.start },
    end: { ...range.end },
  };
}
