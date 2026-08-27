import type { PiSessionMetadata } from "@fragno-dev/pi-harness/types";
import { Type, type TSchema } from "typebox";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { FileSearchMatch } from "@/file-collection/file-collection";
import {
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "@/fragno/automation/engine/codemode-invocation";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";

import type {
  BackofficeCodemodeExecuteResult,
  RunBackofficeCodemodeInput,
} from "../codemode/execute";
import type {
  InteractiveRuntimeToolContext,
  RegisteredAutomationsRuntime,
} from "../runtime-tools/bash-host";
import type {
  AutomationWorkflowRuntime,
  InternalAutomationWorkflowRuntime,
  WorkflowCreateInstanceResult,
} from "../runtime-tools/families/automations-workflow";
import type { OtpRuntime } from "../runtime-tools/families/otp-runtime";
import type { PiRuntime } from "../runtime-tools/families/pi";
import type { ResendRuntime } from "../runtime-tools/families/resend";
import type { Reson8Runtime } from "../runtime-tools/families/reson8";
import type { TelegramRuntime } from "../runtime-tools/families/telegram-runtime";
import { createBackofficeToolContext } from "../runtime-tools/tool-context";
import {
  runtimeToolFamilies,
  type CoreBackofficeToolContext,
} from "../runtime-tools/tool-families";
import { type PiToolId } from "./pi-shared";

export type PiRuntimeToolContext = InteractiveRuntimeToolContext & {
  automations: { runtime: RegisteredAutomationsRuntime };
  otp: { runtime: OtpRuntime };
  pi: { runtime: PiRuntime };
  reson8: { runtime: Reson8Runtime };
  resend: { runtime: ResendRuntime };
  telegram: { runtime: TelegramRuntime };
};

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

const defineTool = <TParameters extends TSchema, TDetails>(
  tool: AgentTool<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> => tool;

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

const createSearchTool = (state: BackofficeStateBackend): AgentTool =>
  defineTool({
    name: "search",
    label: "Search",
    description: "Search file contents in the current scope.",
    parameters: searchParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw new Error("Search aborted.");
      }

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
        details: {
          query: params.query,
          glob: params.glob ?? "**",
          matches,
          cursor,
          hasMore,
        },
      };
    },
  });

const createReadTool = (state: BackofficeStateBackend): AgentTool =>
  defineTool({
    name: "read",
    label: "Read",
    description:
      "Read a known skill or TypeScript declaration from the combined Pi session filesystem. Read selected skills in full before applying them.",
    parameters: readParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw new Error("Read aborted.");
      }

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

const createExecCodeModeTool = (
  sessionId: string,
  codemode: PiCodemodeRuntime | undefined,
  runtimeToolContext: PiRuntimeToolContext | undefined,
  execution: BackofficeExecutionContext,
): AgentTool =>
  defineTool({
    name: "execCodeMode",
    label: "Exec Code Mode",
    description: "Execute one top-level codemode program against the current Backoffice context.",
    parameters: execCodeModeParametersSchema,
    execute: async (toolCallId, params, signal) => {
      const { code, dependencies } = params;
      if (signal?.aborted) {
        throw new Error("Codemode execution aborted.");
      }

      if (!codemode) {
        throw new Error("execCodeMode is not configured for this Pi runtime.");
      }

      if (!runtimeToolContext) {
        throw new Error("execCodeMode requires a Backoffice runtime context.");
      }

      const workflowRuntime = runtimeToolContext.workflow?.runtime ?? codemode.workflow;
      const workflowScheduler =
        codemode.workflow ??
        (workflowRuntime && "createInternalInstance" in workflowRuntime
          ? (workflowRuntime as Pick<InternalAutomationWorkflowRuntime, "createInternalInstance">)
          : undefined);
      const context: CoreBackofficeToolContext = createBackofficeToolContext({
        ...runtimeToolContext,
        workflow: workflowRuntime ? { runtime: workflowRuntime } : null,
      });

      const result = await codemode.execute({
        code,
        dependencies,
        families: runtimeToolFamilies,
        toolContext: context,
      });

      // Parse before scheduling so workflow-shaped code remains a successful tool
      // result even when the durable run cannot be created. The client builds its
      // own graph projection directly from the submitted source.
      const workflowVisualization = visualizeWorkflowSource("codemode", code, {
        fallbackName: result.workflowDefinition?.name,
      });
      const parsedWorkflow = workflowVisualization.graph.nodes.some(
        (node) => node.kind === "workflow",
      );

      // Try to schedule the durable run, but treat a scheduling/validation failure
      // as non-fatal: the viewer should still show the workflow the agent wrote.
      let scheduleError: string | undefined;
      // The scheduled run's handle, surfaced to the client so the workflow viewer
      // can subscribe to its live progress (history/status + step emissions).
      let runHandle: WorkflowCreateInstanceResult | undefined;
      if (result.workflowDefinition) {
        if (!workflowScheduler) {
          scheduleError = "execCodeMode workflow definition cannot be scheduled in this runtime.";
        } else {
          try {
            const instanceId = hashToolCallId(`${sessionId}--${toolCallId}`);
            const prepared = prepareCodemodeWorkflowInstance({
              code,
              dependencies,
              filename: `/pi/${sessionId}/${toolCallId}.workflow.js`,
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
              execution,
            });
            const created = await workflowScheduler.createInternalInstance(workflowInput);
            runHandle = { instanceId: created.instanceId };
            result.result = runHandle;
          } catch (error) {
            scheduleError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      const text = scheduleError
        ? `${formatExecCodeModeText(result)}\n\nWorkflow could not be scheduled: ${scheduleError}`
        : formatExecCodeModeText(result);

      // Only a genuine failure with no recognizable workflow is a hard tool error
      // (a thrown error loses `details`, which would hide the workflow from the
      // viewer). When the code parsed into a workflow, keep the result successful
      // and carry the graph, surfacing any run/scheduling error in the text so the
      // model can still react and retry.
      if ((result.error || scheduleError) && !parsedWorkflow) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: {
          ...result,
          code,
          outputText: text,
          // The live run handle so the client can
          // subscribe to realtime progress. Absent when scheduling failed.
          ...(runHandle ? { run: runHandle } : {}),
          ...(scheduleError ? { scheduleError } : {}),
        },
      };
    },
  });

export type BackofficePiToolFactory = (input: {
  sessionId: string;
  execution: BackofficeExecutionContext;
  metadata?: PiSessionMetadata | null;
}) => Promise<Partial<Record<PiToolId, AgentTool>>>;

export type PiRuntimeToolContextSource =
  | PiRuntimeToolContext
  | ((
      execution: BackofficeExecutionContext,
      metadata: PiSessionMetadata | null,
    ) => PiRuntimeToolContext);

export type CreatePiToolFactoryOptions = {
  codemode?: PiCodemodeRuntime;
  runtimeToolContext?: PiRuntimeToolContextSource;
};

const resolvePiRuntimeToolContext = (
  source: PiRuntimeToolContextSource | undefined,
  execution: BackofficeExecutionContext,
  metadata: PiSessionMetadata | null,
) => (typeof source === "function" ? source(execution, metadata) : source);

const requirePiStateBackend = (runtimeToolContext: PiRuntimeToolContext | undefined) => {
  if (!runtimeToolContext?.stateBackend) {
    throw new Error("Pi requires a state backend.");
  }
  return runtimeToolContext.stateBackend;
};

export const resolvePiStateBackend = (
  source: PiRuntimeToolContextSource | undefined,
  execution: BackofficeExecutionContext,
  metadata: PiSessionMetadata | null = null,
) => requirePiStateBackend(resolvePiRuntimeToolContext(source, execution, metadata));

export const createPiToolFactory =
  ({
    codemode,
    runtimeToolContext: runtimeToolContextSource,
  }: CreatePiToolFactoryOptions): BackofficePiToolFactory =>
  async ({ sessionId, execution, metadata = null }) => {
    const runtimeToolContext = resolvePiRuntimeToolContext(
      runtimeToolContextSource,
      execution,
      metadata,
    );
    const stateBackend = requirePiStateBackend(runtimeToolContext);

    return {
      read: createReadTool(stateBackend),
      search: createSearchTool(stateBackend),
      execCodeMode: createExecCodeModeTool(sessionId, codemode, runtimeToolContext, execution),
    };
  };

export const createPiToolRegistry = (
  options: CreatePiToolFactoryOptions & { execution: BackofficeExecutionContext },
) => {
  const createTools = createPiToolFactory(options);
  const createSessionTool =
    (toolId: PiToolId) =>
    async (context: { session: { id: string } }): Promise<AgentTool> => {
      const tool = (
        await createTools({
          sessionId: context.session.id,
          execution: options.execution,
          metadata: null,
        })
      )[toolId];
      if (!tool) {
        throw new Error(`${toolId} is not configured for this Pi runtime.`);
      }
      return tool;
    };

  return {
    read: createSessionTool("read"),
    search: createSessionTool("search"),
    execCodeMode: createSessionTool("execCodeMode"),
  };
};
