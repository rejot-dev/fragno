import { z } from "zod";

import { NonRetryableError } from "@fragno-dev/workflows";

import {
  PI_TOOL_JOURNAL_VERSION,
  type PiPersistedToolCall,
  type PiPersistedToolResult,
  type PiToolReplayContext,
  type PiToolSideEffectReducerRegistry,
} from "../types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const TOOL_JOURNAL_FIELD = "toolJournal";

const persistedToolResultContentSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
    textSignature: z.string().optional(),
  }),
  z.object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string(),
  }),
]);

const persistedToolResultSchema = z.object({
  content: z.array(persistedToolResultContentSchema),
  details: z.unknown(),
});

const persistedToolCallSchema = z.object({
  version: z.literal(PI_TOOL_JOURNAL_VERSION),
  key: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: persistedToolResultSchema,
  isError: z.boolean(),
  source: z.enum(["executed", "replay"]),
  capturedAt: z.number().finite(),
  seq: z.number().int().nonnegative(),
});

const formatToolJournalIssueLocation = (location: string, issue: z.ZodIssue): string => {
  if (issue.path.length === 0) {
    return location;
  }

  return `${location}.${issue.path.join(".")}`;
};

export const buildStableToolCallKey = (sessionId: string, turnId: string, toolCallId: string) =>
  `${sessionId}:${turnId}:${toolCallId}`;

export const compareToolJournalEntries = (a: PiPersistedToolCall, b: PiPersistedToolCall) =>
  a.seq !== b.seq ? a.seq - b.seq : a.capturedAt - b.capturedAt;

export const clonePersistedToolCall = (entry: PiPersistedToolCall): PiPersistedToolCall =>
  structuredClone(entry);

export const buildToolErrorResult = (error: unknown): PiPersistedToolResult => ({
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  details: {},
});

export const extractToolErrorMessage = (result: PiPersistedToolResult): string => {
  for (const block of result.content) {
    if (block.type === "text") {
      return block.text;
    }
  }
  return "Tool execution failed";
};

export const createPersistedToolCall = (options: {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: PiPersistedToolResult;
  isError: boolean;
  source: PiPersistedToolCall["source"];
  seq: number;
}): PiPersistedToolCall => ({
  version: PI_TOOL_JOURNAL_VERSION,
  key: buildStableToolCallKey(options.sessionId, options.turnId, options.toolCallId),
  sessionId: options.sessionId,
  turnId: options.turnId,
  toolCallId: options.toolCallId,
  toolName: options.toolName,
  args: options.args,
  result: options.result,
  isError: options.isError,
  source: options.source,
  capturedAt: Date.now(),
  seq: options.seq,
});

const parsePersistedToolCall = (value: unknown, location: string): PiPersistedToolCall => {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new NonRetryableError(`Invalid tool journal entry at ${location}.`);
  }

  if (value["version"] !== PI_TOOL_JOURNAL_VERSION) {
    throw new NonRetryableError(
      `Unsupported tool journal version at ${location}: ${String(value["version"])}`,
    );
  }

  const parsed = persistedToolCallSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new NonRetryableError(
      `Invalid tool journal entry at ${formatToolJournalIssueLocation(location, issue)}: ${issue.message}`,
    );
  }

  return parsed.data as PiPersistedToolCall;
};

export const parsePersistedToolJournal = (
  assistantResult: unknown,
  stepName: string,
): PiPersistedToolCall[] => {
  if (!isRecord(assistantResult) || Array.isArray(assistantResult)) {
    throw new NonRetryableError(`Assistant step ${stepName} returned an invalid result object.`);
  }
  if (!(TOOL_JOURNAL_FIELD in assistantResult)) {
    return [];
  }
  const raw = assistantResult[TOOL_JOURNAL_FIELD];
  if (!Array.isArray(raw)) {
    throw new NonRetryableError(`Assistant step ${stepName} contains an invalid tool journal.`);
  }
  return raw.map((entry, index) => parsePersistedToolCall(entry, `${stepName}[${index}]`));
};

export const hydrateReplayCache = (
  cache: PiToolReplayContext["cache"],
  entries: PiPersistedToolCall[],
): void => {
  const sorted = [...entries].sort(compareToolJournalEntries);
  for (const entry of sorted) {
    if (entry.source === "replay" && cache.has(entry.key)) {
      continue;
    }
    cache.set(entry.key, clonePersistedToolCall(entry));
  }
};

// --- Side-effect reducers ---

const reduceBashSideEffects = (state: unknown, entry: PiPersistedToolCall): unknown => {
  const details = isRecord(entry.result.details)
    ? (entry.result.details as {
        cwd?: unknown;
        files?: unknown;
        writes?: unknown;
        deletes?: unknown;
        deletedPaths?: unknown;
      })
    : {};
  const base = isRecord(state) ? (state as { cwd?: unknown; files?: unknown }) : {};

  const next = {
    cwd:
      typeof details.cwd === "string" ? details.cwd : typeof base.cwd === "string" ? base.cwd : "/",
    files:
      isRecord(base.files) && !Array.isArray(base.files)
        ? ({ ...(base.files as Record<string, unknown>) } as Record<string, unknown>)
        : ({} as Record<string, unknown>),
  };

  const detailsFiles =
    isRecord(details.files) && !Array.isArray(details.files) ? details.files : null;
  if (detailsFiles) {
    for (const [path, value] of Object.entries(detailsFiles)) {
      next.files[path] = value;
    }
  }

  if (Array.isArray(details.writes)) {
    for (const item of details.writes) {
      if (!isRecord(item)) {
        continue;
      }
      const writeEntry = item as { path?: unknown; content?: unknown };
      const path = typeof writeEntry.path === "string" ? writeEntry.path : null;
      if (!path) {
        continue;
      }
      next.files[path] = typeof writeEntry.content === "string" ? writeEntry.content : "";
    }
  }

  const deletes = Array.isArray(details.deletes)
    ? details.deletes
    : Array.isArray(details.deletedPaths)
      ? details.deletedPaths
      : [];
  for (const path of deletes) {
    if (typeof path === "string") {
      delete next.files[path];
    }
  }

  return next;
};

const buildSideEffectState = (options: {
  cache: PiToolReplayContext["cache"];
  reducers?: PiToolSideEffectReducerRegistry;
}): Record<string, unknown> => {
  const reducers: PiToolSideEffectReducerRegistry = {
    bash: reduceBashSideEffects,
    ...options.reducers,
  };

  const state: Record<string, unknown> = {};
  const journal = [...options.cache.values()].sort(compareToolJournalEntries);

  for (const entry of journal) {
    const reducer = reducers[entry.toolName];
    if (!reducer) {
      continue;
    }

    try {
      state[entry.toolName] = reducer(state[entry.toolName], entry, {
        key: entry.key,
        sessionId: entry.sessionId,
        turnId: entry.turnId,
      });
    } catch (error) {
      throw new NonRetryableError(
        `Tool side-effect reducer failed for ${entry.toolName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return state;
};

// --- Replay context ---

const replaySequenceByContext = new WeakMap<PiToolReplayContext, number>();

export const takeNextReplaySequence = (replayContext: PiToolReplayContext): number => {
  const current = replaySequenceByContext.get(replayContext) ?? 0;
  replaySequenceByContext.set(replayContext, current + 1);
  return current;
};

export const createReplayContext = (options: {
  cache: PiToolReplayContext["cache"];
  reducers?: PiToolSideEffectReducerRegistry;
}): PiToolReplayContext => {
  const localCache: PiToolReplayContext["cache"] = new Map();
  for (const [key, entry] of options.cache.entries()) {
    localCache.set(key, clonePersistedToolCall(entry));
  }

  const replayContext: PiToolReplayContext = {
    cache: localCache,
    journal: [],
    sideEffects: buildSideEffectState({ cache: localCache, reducers: options.reducers }),
  };
  const maxSeq = [...localCache.values()].reduce(
    (max, entry) => (entry.seq > max ? entry.seq : max),
    -1,
  );
  replaySequenceByContext.set(replayContext, maxSeq + 1);
  return replayContext;
};
