import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeTracePath,
  resolveWorkspaceRoot,
  type NormalizedTracePath,
} from "../util/paths.js";

export type EventTraceRawEvent = {
  name: string;
  cat?: string;
  ph: string;
  ts: number;
  pid: number;
  tid: number;
  dur?: number;
  args?: Record<string, unknown>;
};

export type NormalizedEventTraceEvent = {
  name: string;
  category: string;
  phase: string;
  timestamp: number;
  pid: number;
  tid: number;
  duration?: number;
  path?: NormalizedTracePath;
  args: Record<string, unknown>;
};

export type EventTraceLoadResult = {
  traceDir: string;
  filePath: string;
  workspaceRoot: string;
  metadataEvents: NormalizedEventTraceEvent[];
  events: NormalizedEventTraceEvent[];
};

const normalizeEventTraceEvent = (
  event: EventTraceRawEvent,
  workspaceRoot: string,
): NormalizedEventTraceEvent => {
  const args = event.args ?? {};
  const pathValue = typeof args["path"] === "string" ? args["path"] : undefined;

  return {
    name: event.name,
    category: event.cat ?? "",
    phase: event.ph,
    timestamp: event.ts,
    pid: event.pid,
    tid: event.tid,
    duration: event.dur,
    path: pathValue ? normalizeTracePath(pathValue, workspaceRoot) : undefined,
    args,
  };
};

export const loadEventTrace = (
  traceDir: string,
  options?: {
    workspaceRoot?: string;
  },
): EventTraceLoadResult => {
  const workspaceRoot = resolveWorkspaceRoot(options?.workspaceRoot);
  const filePath = join(traceDir, "trace.json");
  const rawValue = JSON.parse(readFileSync(filePath, "utf8")) as unknown;

  if (!Array.isArray(rawValue)) {
    throw new Error(`Expected ${filePath} to contain a JSON array.`);
  }

  const normalizedEvents = rawValue.map((value) =>
    normalizeEventTraceEvent(value as EventTraceRawEvent, workspaceRoot),
  );

  return {
    traceDir,
    filePath,
    workspaceRoot,
    metadataEvents: normalizedEvents.filter(
      (event) => event.phase === "M" || event.category === "__metadata",
    ),
    events: normalizedEvents.filter(
      (event) => !(event.phase === "M" || event.category === "__metadata"),
    ),
  };
};
