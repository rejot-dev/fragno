import { Type } from "typebox";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import { copyJson, type Context } from "@earendil-works/chord";
import { defineTool } from "@earendil-works/pi-durable";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficePermissionRequirement } from "@/backoffice-runtime/permissions";
import type { FileSearchMatch } from "@/file-collection/file-collection";
import {
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "@/fragno/automation/engine/codemode-invocation";
import { AutomationWorkflowRuntimeRequestError } from "@/fragno/automation/workflow-route-runtime";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";

import type {
  BackofficeCodemodeExecuteResult,
  RunBackofficeCodemodeInput,
} from "../codemode/execute";
import type {
  AutomationWorkflowRuntime,
  InternalAutomationWorkflowRuntime,
  WorkflowCreateInstanceResult,
} from "../runtime-tools/families/automations-workflow";
import { createBackofficeToolContext } from "../runtime-tools/tool-context";
import {
  runtimeToolFamilies,
  type CoreBackofficeToolContext,
} from "../runtime-tools/tool-families";
import { requirePiStateBackend, type PiRuntimeToolContext } from "./pi-runtime-context";

export type PiCodemodeRuntime = {
  execute(input: Omit<RunBackofficeCodemodeInput, "env">): Promise<BackofficeCodemodeExecuteResult>;
  workflow?: AutomationWorkflowRuntime &
    Pick<InternalAutomationWorkflowRuntime, "createInternalInstance">;
};

const searchParametersSchema = Type.Object({
  query: Type.String({ minLength: 1, description: "Text to search for." }),
  glob: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Workspace Upload key glob to search. Defaults to all files.",
    }),
  ),
  caseSensitive: Type.Optional(Type.Boolean()),
  wholeWord: Type.Optional(Type.Boolean()),
  contextBefore: Type.Optional(Type.Number({ minimum: 0, maximum: 200 })),
  contextAfter: Type.Optional(Type.Number({ minimum: 0, maximum: 200 })),
  maxMatches: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(
    Type.Object({
      upload: Type.Optional(Type.String()),
      static: Type.Optional(Type.String()),
    }),
  ),
});

const readParametersSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to read (relative or absolute).",
  }),
  offset: Type.Optional(
    Type.Number({
      description: "Line number to start reading from (1-indexed).",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
});

export const execCodeModeParametersSchema = Type.Object({
  code: Type.String({
    minLength: 1,
    description:
      "One top-level codemode program: an async arrow function for immediate work or defineWorkflow(...) for durable work.",
  }),
  dependencies: Type.Optional(
    Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), {
      description:
        "npm package names mapped to versions or version ranges. Import packages by their normal unversioned names in code.",
    }),
  ),
});

const normalizeReadPath = (path: string) => (path.startsWith("/") ? path : `/${path}`);

const applyLineRange = (content: string, offset?: number, limit?: number) => {
  if (offset === undefined && limit === undefined) {
    return content;
  }

  const lines = content.split("\n");
  const startIndex = offset === undefined ? 0 : Math.max(0, Math.trunc(offset) - 1);
  const endIndex = limit === undefined ? undefined : startIndex + Math.max(0, Math.trunc(limit));
  return lines.slice(startIndex, endIndex).join("\n");
};

type SearchMatchWithLineText = FileSearchMatch & { lineText?: string };
type SearchMountPage = Awaited<ReturnType<BackofficeStateBackend["searchFiles"]>>["upload"];
type SearchMountCursor = { sourceCursor?: string; skip: number };

const SEARCH_MOUNT_CURSOR_PREFIX = "pi-search:";

const decodeSearchMountCursor = (cursor: string | undefined): SearchMountCursor => {
  if (!cursor) {
    return { skip: 0 };
  }
  if (!cursor.startsWith(SEARCH_MOUNT_CURSOR_PREFIX)) {
    return { sourceCursor: cursor, skip: 0 };
  }

  const parsed = JSON.parse(cursor.slice(SEARCH_MOUNT_CURSOR_PREFIX.length)) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("skip" in parsed) ||
    !Number.isInteger(parsed.skip) ||
    (parsed.skip as number) < 0 ||
    ("sourceCursor" in parsed &&
      parsed.sourceCursor !== undefined &&
      typeof parsed.sourceCursor !== "string")
  ) {
    throw new Error("Invalid search cursor.");
  }
  return parsed as SearchMountCursor;
};

const encodeSearchMountCursor = (cursor: SearchMountCursor): string =>
  `${SEARCH_MOUNT_CURSOR_PREFIX}${JSON.stringify(cursor)}`;

const flattenSearchMountPage = (page: SearchMountPage): SearchMatchWithLineText[] =>
  page.results.flatMap((file) =>
    file.matches.map((match) => ({
      path: file.path,
      line: match.line,
      column: match.column,
      text: match.match,
      lineText: match.lineText,
      contextBefore: match.beforeLines ?? [],
      contextAfter: match.afterLines ?? [],
    })),
  );

const nextSearchMountCursor = (
  current: SearchMountCursor,
  page: SearchMountPage,
  pageMatchCount: number,
  consumedCount: number,
): string | undefined => {
  const remainingInPage = Math.max(0, pageMatchCount - current.skip);
  if (consumedCount < remainingInPage) {
    return encodeSearchMountCursor({
      ...(current.sourceCursor ? { sourceCursor: current.sourceCursor } : {}),
      skip: current.skip + consumedCount,
    });
  }
  if (page.hasMore && page.cursor) {
    return encodeSearchMountCursor({ sourceCursor: page.cursor, skip: 0 });
  }
  return undefined;
};

type SearchOutputLine = {
  line: number;
  column?: number;
  text: string;
  isMatch: boolean;
};

export const formatSearchMatches = (matches: readonly SearchMatchWithLineText[]): string => {
  const blocks: Array<{
    path: string;
    start: number;
    end: number;
    lines: Map<number, SearchOutputLine>;
  }> = [];

  for (const match of matches) {
    const start = match.line - match.contextBefore.length;
    const end = match.line + match.contextAfter.length;
    const previousBlock = blocks.at(-1);
    const block =
      previousBlock?.path === match.path && start <= previousBlock.end + 1
        ? previousBlock
        : {
            path: match.path,
            start,
            end,
            lines: new Map<number, SearchOutputLine>(),
          };

    if (block !== previousBlock) {
      blocks.push(block);
    } else {
      block.end = Math.max(block.end, end);
    }

    match.contextBefore.forEach((text, index) => {
      const line = start + index;
      if (!block.lines.has(line)) {
        block.lines.set(line, { line, text, isMatch: false });
      }
    });

    const existingMatchLine = block.lines.get(match.line);
    block.lines.set(match.line, {
      line: match.line,
      column: Math.min(existingMatchLine?.column ?? match.column, match.column),
      text: match.lineText ?? match.text,
      isMatch: true,
    });

    match.contextAfter.forEach((text, index) => {
      const line = match.line + index + 1;
      if (!block.lines.has(line)) {
        block.lines.set(line, { line, text, isMatch: false });
      }
    });
  }

  return blocks
    .map((block) => {
      const lines = [...block.lines.values()]
        .sort((left, right) => left.line - right.line)
        .map((line) =>
          line.isMatch
            ? `> ${line.line}:${line.column} | ${line.text}`
            : `  ${line.line} | ${line.text}`,
        )
        .join("\n");
      return `${block.path}\n${lines}`;
    })
    .join("\n\n");
};

type PiToolExecutionOptions = {
  sessionId: string;
  authorizeExecution: () => Promise<void>;
  createRuntimeToolContext: (input: {
    invocationId: string;
    context: Context;
  }) => PiRuntimeToolContext;
};

function piToolInvocationId(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`;
}

function createSearchTool(options: PiToolExecutionOptions) {
  return defineTool({
    name: "search",
    description: "Search file contents in the current scope.",
    parameters: searchParametersSchema,
    replay: "safe",
    async execute(params, api, context) {
      await options.authorizeExecution();
      if (context.abortSignal?.aborted) {
        throw new Error("Search aborted.");
      }

      const state = requirePiStateBackend(
        options.createRuntimeToolContext({
          invocationId: piToolInvocationId(options.sessionId, String(api.taskId)),
          context,
        }),
      );
      const maxMatches = params.maxMatches ?? 50;
      const searchOptions = {
        caseSensitive: params.caseSensitive,
        wholeWord: params.wholeWord,
        contextBefore: params.contextBefore,
        contextAfter: params.contextAfter,
        maxMatches,
      };
      const uploadCursor = decodeSearchMountCursor(params.cursor?.upload);
      const staticCursor = decodeSearchMountCursor(params.cursor?.static);
      const requestedMounts = params.cursor
        ? {
            ...(params.cursor.upload
              ? {
                  upload: {
                    ...searchOptions,
                    ...(uploadCursor.sourceCursor ? { cursor: uploadCursor.sourceCursor } : {}),
                  },
                }
              : {}),
            ...(params.cursor.static
              ? {
                  static: {
                    ...searchOptions,
                    ...(staticCursor.sourceCursor ? { cursor: staticCursor.sourceCursor } : {}),
                  },
                }
              : {}),
          }
        : { upload: searchOptions, static: searchOptions };
      const result = await state.searchFiles(params.glob ?? "**", params.query, requestedMounts);
      const uploadPageMatches = flattenSearchMountPage(result.upload);
      const staticPageMatches = flattenSearchMountPage(result.static);
      const uploadMatches = uploadPageMatches.slice(uploadCursor.skip);
      const staticMatches = staticPageMatches.slice(staticCursor.skip);
      const matches: SearchMatchWithLineText[] = [...uploadMatches, ...staticMatches].slice(
        0,
        maxMatches,
      );
      const consumedUploadMatches = Math.min(matches.length, uploadMatches.length);
      const consumedStaticMatches = matches.length - consumedUploadMatches;
      const nextUploadCursor = nextSearchMountCursor(
        uploadCursor,
        result.upload,
        uploadPageMatches.length,
        consumedUploadMatches,
      );
      const nextStaticCursor = nextSearchMountCursor(
        staticCursor,
        result.static,
        staticPageMatches.length,
        consumedStaticMatches,
      );
      const cursor = {
        ...(nextUploadCursor ? { upload: nextUploadCursor } : {}),
        ...(nextStaticCursor ? { static: nextStaticCursor } : {}),
      };
      const hasMore = {
        upload: nextUploadCursor !== undefined,
        static: nextStaticCursor !== undefined,
      };
      const continuation =
        hasMore.upload || hasMore.static
          ? `\n\nMore files are available. Continue with cursor: ${JSON.stringify(cursor)}`
          : "";

      return {
        content: [
          {
            type: "text",
            text: `${formatSearchMatches(matches)}${continuation}`,
          },
        ],
        details: copyJson({
          query: params.query,
          glob: params.glob ?? "**",
          matches,
          cursor,
          hasMore,
        }),
      };
    },
  });
}

function createReadTool(options: PiToolExecutionOptions) {
  return defineTool({
    name: "read",
    description:
      "Read a known skill or TypeScript declaration from the combined Pi session filesystem. Read selected skills in full before applying them.",
    parameters: readParametersSchema,
    replay: "safe",
    async execute(params, api, context) {
      await options.authorizeExecution();
      if (context.abortSignal?.aborted) {
        throw new Error("Read aborted.");
      }

      const state = requirePiStateBackend(
        options.createRuntimeToolContext({
          invocationId: piToolInvocationId(options.sessionId, String(api.taskId)),
          context,
        }),
      );
      const path = normalizeReadPath(params.path);
      const text = applyLineRange(await state.readFile(path), params.offset, params.limit);
      return {
        content: [{ type: "text", text }],
        details: {
          path,
          offset: params.offset ?? null,
          limit: params.limit ?? null,
        },
      };
    },
  });
}

const hashToolCallId = (toolCallId: string) => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < toolCallId.length; index += 1) {
    const char = toolCallId.charCodeAt(index);
    first = Math.imul(first ^ char, 0x01000193);
    second = Math.imul(second ^ char, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
};

const formatExecCodeModeText = (result: BackofficeCodemodeExecuteResult) => {
  const lines: string[] = [];
  const logs = result.logs ?? [];
  lines.push(...logs);

  if (result.error) {
    lines.push(result.error);
    return lines.join("\n");
  }

  if (result.result === undefined) {
    return lines.join("\n");
  }

  lines.push(
    typeof result.result === "string" ? result.result : (JSON.stringify(result.result) ?? ""),
  );
  return lines.join("\n");
};

type ExecCodeModeToolOptions = PiToolExecutionOptions & {
  execution: BackofficeExecutionContext;
  codemode: PiCodemodeRuntime;
};

type WorkflowScheduleErrorDetails = {
  status: number | null;
  code: string;
  message: string;
  requiredPermission: BackofficePermissionRequirement | null;
};

function serializeWorkflowScheduleError(cause: unknown): WorkflowScheduleErrorDetails {
  if (AutomationWorkflowRuntimeRequestError.is(cause)) {
    return {
      status: cause.status,
      code: cause.code,
      message: cause.message,
      requiredPermission: cause.requiredPermission,
    };
  }

  return {
    status: null,
    code: "WORKFLOW_SCHEDULING_FAILED",
    message: cause instanceof Error ? cause.message : String(cause),
    requiredPermission: null,
  };
}

function createExecCodeModeTool(options: ExecCodeModeToolOptions) {
  return defineTool({
    name: "execCodeMode",
    description: "Execute one top-level codemode program against the current Backoffice context.",
    parameters: execCodeModeParametersSchema,
    // Codemode can execute arbitrary mutations. An interrupted call must not silently repeat them.
    replay: "unsafe",
    async execute(params, api, durableContext) {
      await options.authorizeExecution();
      const { code, dependencies } = params;
      if (durableContext.abortSignal?.aborted) {
        throw new Error("Codemode execution aborted.");
      }

      const taskId = String(api.taskId);
      const runtimeToolContext = options.createRuntimeToolContext({
        invocationId: piToolInvocationId(options.sessionId, taskId),
        context: durableContext,
      });
      const workflowRuntime = runtimeToolContext.workflow?.runtime ?? options.codemode.workflow;
      const workflowScheduler =
        options.codemode.workflow ??
        (workflowRuntime && "createInternalInstance" in workflowRuntime
          ? (workflowRuntime as Pick<InternalAutomationWorkflowRuntime, "createInternalInstance">)
          : undefined);
      const toolContext: CoreBackofficeToolContext = createBackofficeToolContext({
        ...runtimeToolContext,
        workflow: workflowRuntime ? { runtime: workflowRuntime } : null,
      });

      const result = await options.codemode.execute({
        code,
        dependencies,
        families: runtimeToolFamilies,
        toolContext,
      });

      // Parse before scheduling so workflow-shaped failures retain tool details. The client builds
      // its graph projection directly from the submitted source even when no run was created.
      const workflowVisualization = visualizeWorkflowSource("codemode", code, {
        fallbackName: result.workflowDefinition?.name,
      });
      const parsedWorkflow = workflowVisualization.graph.nodes.some(
        (node) => node.kind === "workflow",
      );

      // Scheduling failures are failed tool results, but still carry the authored workflow for the viewer.
      let scheduleError: WorkflowScheduleErrorDetails | undefined;
      // The scheduled run's handle, surfaced to the client so the workflow viewer
      // can subscribe to its live progress (history/status + step emissions).
      let runHandle: WorkflowCreateInstanceResult | undefined;
      if (result.workflowDefinition) {
        if (!workflowScheduler) {
          scheduleError = {
            status: null,
            code: "WORKFLOW_SCHEDULER_UNAVAILABLE",
            message: "execCodeMode workflow definition cannot be scheduled in this runtime.",
            requiredPermission: null,
          };
        } else {
          try {
            const instanceId = hashToolCallId(`${options.sessionId}--${taskId}`);
            const prepared = prepareCodemodeWorkflowInstance({
              code,
              dependencies,
              filename: `/pi/${options.sessionId}/${taskId}.workflow.js`,
              instanceId,
            });
            if (prepared.remoteWorkflowName !== result.workflowDefinition.name) {
              throw new Error(
                `Codemode program '${prepared.program.filename}' declares workflow '${prepared.remoteWorkflowName}', expected '${result.workflowDefinition.name}'.`,
              );
            }
            const workflowInput = createCodemodeWorkflowInstanceInput({
              prepared,
              trigger: { type: "manual", payload: {} },
              execution: options.execution,
            });
            const created = await workflowScheduler.createInternalInstance(workflowInput);
            runHandle = { instanceId: created.instanceId };
            result.result = runHandle;
          } catch (error) {
            scheduleError = serializeWorkflowScheduleError(error);
          }
        }
      }

      const text = scheduleError
        ? `${formatExecCodeModeText(result)}\n\nWorkflow could not be scheduled: ${scheduleError.message}`
        : formatExecCodeModeText(result);

      // Throw only when there is no workflow graph to preserve. Recognized workflows return an
      // error result with details so both the viewer and model can inspect the scheduling failure.
      if ((result.error || scheduleError) && !parsedWorkflow) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        isError: Boolean(result.error || scheduleError),
        details: copyJson(
          {
            ...result,
            code,
            outputText: text,
            // The live run handle so the client can
            // subscribe to realtime progress. Absent when scheduling failed.
            ...(runHandle ? { run: runHandle } : {}),
            ...(scheduleError ? { scheduleError } : {}),
          },
          { omitUndefinedProperties: true },
        ),
      };
    },
  });
}

export type CreateBackofficePiToolsOptions = PiToolExecutionOptions & {
  execution: BackofficeExecutionContext;
  codemode: PiCodemodeRuntime;
};

/** Creates the native durable Pi tools for one agent configuration. */
export function createBackofficePiTools(options: CreateBackofficePiToolsOptions) {
  return {
    execCodeMode: createExecCodeModeTool(options),
    read: createReadTool(options),
    search: createSearchTool(options),
  };
}
