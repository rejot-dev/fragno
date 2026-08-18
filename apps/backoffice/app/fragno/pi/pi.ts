import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createPiHarness, createPiWorkflows } from "@fragno-dev/pi-harness/factory";
import type { PiFragmentConfig, PiSessionMetadata } from "@fragno-dev/pi-harness/types";
import { createInteractiveChatWorkflow } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import {
  NonRetryableError,
  type WorkflowRegistryEntry,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows/workflow";
import { Type, type TSchema } from "typebox";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import {
  formatSkillsForSystemPrompt,
  type AgentTool,
  type Skill,
} from "@earendil-works/pi-agent-core";
import type { AuthContext, Models } from "@earendil-works/pi-ai";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeDatabaseAdapterFactory } from "@/backoffice-runtime/database-adapters";
import { BackofficeForbiddenError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import type { FileSearchMatch } from "@/file-collection/file-collection";
import { createBackofficeFileSystem, type MasterFileSystem } from "@/files";
import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";
import { automationActorsSchema } from "@/fragno/automation/actors";
import {
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "@/fragno/automation/engine/codemode-invocation";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";
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
import {
  BACKOFFICE_PI_WORKFLOW_NAME,
  piSessionBillingOrganizationId,
  piSessionModel,
  PI_BILLING_ORGANIZATION_ID_METADATA_KEY,
  PI_SUPPORTED_MODELS,
  PI_PROVIDER_TO_MODEL_PROVIDER,
  PI_SYSTEM_PROMPT,
  PI_THINKING_LEVEL,
  PI_TOOL_IDS,
  type PiApiKeys,
  type PiModel,
  type PiToolId,
} from "./pi-shared";
import { loadBackofficePiSkills } from "./pi-skills";

export type PiFragment = ReturnType<typeof createPiHarness<BackofficeExecutionContext>>;

export type PiRuntimeDefinition = {
  workflows: WorkflowsRegistry;
  createFragment(input: {
    databaseAdapter: ReturnType<BackofficeDatabaseAdapterFactory["createAdapter"]>;
    workflows: WorkflowsFragmentServices;
    mountRoute?: string;
  }): PiFragment;
};

export type PiRuntimeToolContext = InteractiveRuntimeToolContext & {
  automations: {
    runtime: RegisteredAutomationsRuntime;
  };
  otp: {
    runtime: OtpRuntime;
  };
  pi: {
    runtime: PiRuntime;
  };
  reson8: {
    runtime: Reson8Runtime;
  };
  resend: {
    runtime: ResendRuntime;
  };
  telegram: {
    runtime: TelegramRuntime;
  };
};

export type PiSessionFileSystemContext = {
  scope: BackofficeContextScope;
  objects: BackofficeObjectRegistry;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  runtimeConfig: import("@/backoffice-runtime/runtime-services").BackofficeRuntimeConfig;
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

const getSessionFs = async (
  cache: Map<string, Promise<MasterFileSystem>>,
  sessionId: string,
  context: PiSessionFileSystemContext,
) => {
  const existing = cache.get(sessionId);
  if (existing) {
    return existing;
  }

  const pendingFileSystem = createBackofficeFileSystem({
    objects: context.objects,
    kernel: context.kernel,
    execution: context.execution,
    config: context.runtimeConfig,
  });

  cache.set(sessionId, pendingFileSystem);

  try {
    return await pendingFileSystem;
  } catch (error) {
    cache.delete(sessionId);
    throw error;
  }
};

type BackofficePiToolFactory = (input: {
  sessionId: string;
  execution: BackofficeExecutionContext;
  metadata?: PiSessionMetadata | null;
}) => Promise<Partial<Record<PiToolId, AgentTool>>>;

type PiRuntimeToolContextSource =
  | PiRuntimeToolContext
  | ((
      execution: BackofficeExecutionContext,
      metadata: PiSessionMetadata | null,
    ) => PiRuntimeToolContext);

type CreatePiToolFactoryOptions = {
  sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
  sessionFileSystemContext: PiSessionFileSystemContext;
  codemode?: PiCodemodeRuntime;
  runtimeToolContext?: PiRuntimeToolContextSource;
};

const resolvePiRuntimeToolContext = (
  source: PiRuntimeToolContextSource | undefined,
  execution: BackofficeExecutionContext,
  metadata: PiSessionMetadata | null,
) => (typeof source === "function" ? source(execution, metadata) : source);

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
    if (!runtimeToolContext?.stateBackend) {
      throw new Error("Pi tools require a state backend.");
    }

    return {
      read: createReadTool(runtimeToolContext.stateBackend),
      search: createSearchTool(runtimeToolContext.stateBackend),
      execCodeMode: createExecCodeModeTool(sessionId, codemode, runtimeToolContext, execution),
    };
  };

export const createPiToolRegistry = (options: CreatePiToolFactoryOptions) => {
  const createTools = createPiToolFactory(options);
  const createSessionTool =
    (toolId: PiToolId) =>
    async (context: { session: { id: string } }): Promise<AgentTool> => {
      const tool = (
        await createTools({
          sessionId: context.session.id,
          execution: options.sessionFileSystemContext.execution,
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

const resolveBackofficeModel = (
  models: Models,
  provider: keyof typeof PI_PROVIDER_TO_MODEL_PROVIDER,
  modelName: string,
) =>
  models
    .getModels(PI_PROVIDER_TO_MODEL_PROVIDER[provider])
    .find((model) => model.name === modelName || model.id === modelName);

const createBackofficeAuthContext = (apiKeys: PiApiKeys): AuthContext => ({
  env: async (name) => {
    switch (name) {
      case "OPENAI_API_KEY":
        return apiKeys.openai;
      case "ANTHROPIC_API_KEY":
        return apiKeys.anthropic;
      case "GEMINI_API_KEY":
        return apiKeys.gemini;
      default:
        return undefined;
    }
  },
  fileExists: async () => false,
});

type BackofficePiSkillResolver = (input: {
  sessionId: string;
  execution: BackofficeExecutionContext;
}) => Promise<Skill[]>;

const createBackofficePiSkillResolver =
  (options: {
    sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
    sessionFileSystemContext: PiSessionFileSystemContext;
  }): BackofficePiSkillResolver =>
  async ({ sessionId, execution }) => {
    const fileSystem = await getSessionFs(options.sessionFileSystems, sessionId, {
      ...options.sessionFileSystemContext,
      execution,
    });
    const skills = await loadBackofficePiSkills(fileSystem);
    return Object.values(skills).map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.body ?? "",
      filePath: skill.location ?? `${skill.directory ?? "/skills"}/${skill.name}/SKILL.md`,
    }));
  };

type BackofficeSystemPromptResolver = (options: {
  sessionId: string;
  execution: BackofficeExecutionContext;
  baseSystemPrompt: string;
}) => Promise<string>;

const createBackofficeSystemPromptResolver =
  (options: {
    sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
    sessionFileSystemContext: PiSessionFileSystemContext;
  }): BackofficeSystemPromptResolver =>
  async ({ sessionId, execution, baseSystemPrompt }) => {
    const fileSystem = await getSessionFs(options.sessionFileSystems, sessionId, {
      ...options.sessionFileSystemContext,
      execution,
    });
    return `${baseSystemPrompt}\n\n${await renderCodemodeSystemPrompt({ fileSystem })}`;
  };

const buildSystemPrompt = async (options: {
  systemPrompt?: string;
  skills: Skill[];
  resolveSystemPrompt: BackofficeSystemPromptResolver;
  sessionId: string;
  execution: BackofficeExecutionContext;
}) => {
  const baseSystemPrompt = [
    options.systemPrompt ?? PI_SYSTEM_PROMPT,
    formatSkillsForSystemPrompt(options.skills),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return await options.resolveSystemPrompt({
    sessionId: options.sessionId,
    execution: options.execution,
    baseSystemPrompt,
  });
};

const resolveDefaultBackofficePiModel = async (models: Models): Promise<PiModel | null> => {
  for (const option of PI_SUPPORTED_MODELS) {
    const resolvedModel = resolveBackofficeModel(models, option.provider, option.name);
    if (resolvedModel && (await models.checkAuth(resolvedModel.provider))) {
      return { provider: option.provider, name: option.name };
    }
  }
  return null;
};

const validateBackofficePiModel = (models: Models, selection: PiModel): string | null => {
  const model = resolveBackofficeModel(models, selection.provider, selection.name);
  return model ? null : `Model ${selection.provider}/${selection.name} not found.`;
};

class PiSessionBillingOwnerMissingError extends NonRetryableError {
  constructor(readonly userId: string) {
    super(`User-scoped Pi session ${userId} has no billing organization.`);
    this.name = "PiSessionBillingOwnerMissingError";
  }
}

class PiSessionBillingOrganizationAccessDeniedError extends NonRetryableError {
  constructor(readonly organizationId: string) {
    super(`Pi session billing organization ${organizationId} is no longer available.`);
    this.name = "PiSessionBillingOrganizationAccessDeniedError";
  }
}

const authorizePiBillingOrganization = async ({
  kernel,
  execution,
  organizationId,
  resource,
}: {
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  organizationId: string;
  resource: Record<string, unknown>;
}): Promise<void> => {
  await kernel.assertAuthorized({
    execution: {
      ...execution,
      scope: { kind: "org", orgId: organizationId },
    },
    operation: BACKOFFICE_PERMISSION.pi.modify,
    resource,
  });
};

class PiSessionActorMetadataInvalidError extends NonRetryableError {
  constructor() {
    super("PI_SESSION_ACTOR_METADATA_INVALID", "PiSessionActorMetadataInvalidError");
  }
}

export const createBackofficePiSessionExecution = (
  scope: BackofficeContextScope,
  metadata: PiSessionMetadata | null,
): BackofficeExecutionContext => {
  const actors = automationActorsSchema.safeParse(
    metadata?.[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY],
  );
  if (!actors.success) {
    throw new PiSessionActorMetadataInvalidError();
  }

  return { scope, actors: actors.data };
};

const createBackofficeInteractiveChatWorkflow = ({
  config,
  kernel,
  models,
  createTools,
  skills,
  resolveSystemPrompt,
}: {
  config: { scope: BackofficeContextScope };
  kernel: BackofficeKernel;
  models: Models;
  createTools: BackofficePiToolFactory;
  skills: BackofficePiSkillResolver;
  resolveSystemPrompt: BackofficeSystemPromptResolver;
}): WorkflowRegistryEntry => ({
  ...createInteractiveChatWorkflow({
    name: BACKOFFICE_PI_WORKFLOW_NAME,
    commandTimeout: "1 hour",
    beforeOperation: async (input) => {
      if (config.scope.kind !== "user") {
        return;
      }

      const billingOrganizationId = piSessionBillingOrganizationId(input.metadata);
      if (!billingOrganizationId) {
        throw new PiSessionBillingOwnerMissingError(config.scope.userId);
      }

      try {
        await authorizePiBillingOrganization({
          kernel,
          execution: createBackofficePiSessionExecution(config.scope, input.metadata),
          organizationId: billingOrganizationId,
          resource: {
            kind: "pi-session-operation-billing",
            workflowName: input.workflowName,
            sessionId: input.sessionId,
            operationId: input.operationId,
          },
        });
      } catch (error) {
        if (error instanceof BackofficeForbiddenError && error.reason !== "authority-unavailable") {
          throw new PiSessionBillingOrganizationAccessDeniedError(billingOrganizationId);
        }
        throw error;
      }
    },
    options: async (event) => {
      const selectedModel = piSessionModel(event.payload.metadata);
      if (!selectedModel) {
        throw new Error("BACKOFFICE_PI_MODEL_REQUIRED");
      }

      const model = resolveBackofficeModel(models, selectedModel.provider, selectedModel.name);
      if (!model) {
        throw new Error(`Model ${selectedModel.provider}/${selectedModel.name} not found.`);
      }

      if (!(await models.checkAuth(model.provider))) {
        throw new Error(`API key for provider ${model.provider} is not configured.`);
      }

      const metadata = event.payload.metadata ?? null;
      const execution = createBackofficePiSessionExecution(config.scope, metadata);
      const sessionTools = await createTools({
        sessionId: event.instanceId,
        execution,
        metadata,
      });
      const activeTools = PI_TOOL_IDS.map((toolId) => {
        const tool = sessionTools[toolId];
        if (!tool) {
          throw new Error(`${toolId} is not configured for this Pi runtime.`);
        }
        return tool;
      });
      const agentSkills = await skills({
        sessionId: event.instanceId,
        execution,
      });

      return {
        model,
        models,
        thinkingLevel: event.payload.thinkingLevel ?? PI_THINKING_LEVEL,
        systemPrompt: await buildSystemPrompt({
          systemPrompt: event.payload.systemPrompt,
          skills: agentSkills,
          resolveSystemPrompt,
          sessionId: event.instanceId,
          execution,
        }),
        resources: { skills: agentSkills },
        tools: activeTools,
      };
    },
  }),
  checkpoint: "step",
});

const buildPiRuntime = (
  config: { scope: BackofficeContextScope },
  kernel: BackofficeKernel,
  apiKeys: PiApiKeys,
  createTools: BackofficePiToolFactory,
  skills: BackofficePiSkillResolver,
  resolveSystemPrompt: BackofficeSystemPromptResolver,
  onOperationCompleted: PiFragmentConfig["onOperationCompleted"],
) => {
  const models = builtinModels({
    authContext: createBackofficeAuthContext(apiKeys),
  });
  const workflows = [
    createBackofficeInteractiveChatWorkflow({
      config,
      kernel,
      models,
      createTools,
      skills,
      resolveSystemPrompt,
    }),
  ];
  const piConfig = {
    workflows,
    logging: { enabled: true, level: "debug" },
    onOperationCompleted,
  } satisfies PiFragmentConfig;

  return {
    config: piConfig,
    models,
    workflows: createPiWorkflows(piConfig),
  };
};

export type CreatePiRuntimeDefinitionOptions = {
  scope: BackofficeContextScope;
  apiKeys: PiApiKeys;
  kernel: BackofficeKernel;
  sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
  sessionFileSystemContext: PiSessionFileSystemContext;
  runtimeToolContext: PiRuntimeToolContextSource;
  codemode: PiCodemodeRuntime;
  onOperationCompleted?: PiFragmentConfig["onOperationCompleted"];
};

export const createPiRuntimeDefinition = (
  options: CreatePiRuntimeDefinitionOptions,
): PiRuntimeDefinition => {
  const codemode = options.codemode;
  const createTools = createPiToolFactory({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
    codemode,
    runtimeToolContext: options.runtimeToolContext,
  });
  const skills = createBackofficePiSkillResolver({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
  });
  const resolveSystemPrompt = createBackofficeSystemPromptResolver({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
  });
  const pi = buildPiRuntime(
    { scope: options.scope },
    options.kernel,
    options.apiKeys,
    createTools,
    skills,
    resolveSystemPrompt,
    options.onOperationCompleted,
  );

  const createFragment: PiRuntimeDefinition["createFragment"] = ({
    databaseAdapter,
    workflows,
    mountRoute = "/api/pi",
  }) =>
    createPiHarness<BackofficeExecutionContext>(
      pi.config,
      {
        databaseAdapter,
        mountRoute,
        outbox: { enabled: true },
      },
      { workflows },
    ).withMiddleware(async function authorizePiSessionRoutes(
      { ifMatchesRoute, requestContext, requestState },
      { error },
    ) {
      const authorize = async (
        operation: typeof BACKOFFICE_PERMISSION.pi.read | typeof BACKOFFICE_PERMISSION.pi.modify,
        resource: Record<string, unknown>,
        execution = requestContext,
      ) => {
        if (!execution) {
          return error(
            {
              message: "Pi session routes require trusted action context.",
              code: "context-access-denied",
            },
            403,
          );
        }

        try {
          await options.kernel.assertAuthorized({
            execution,
            operation,
            resource,
          });
          return undefined;
        } catch (cause) {
          if (cause instanceof BackofficeForbiddenError) {
            return error(
              { message: cause.message, code: cause.reason },
              cause.reason === "authority-unavailable" ? 503 : 403,
            );
          }
          throw cause;
        }
      };

      const createResponse = await ifMatchesRoute(
        "POST",
        "/workflows/:workflowName/sessions",
        async ({ input, pathParams }) => {
          const values = await input.valid();
          let model = piSessionModel(values.metadata);
          if (pathParams.workflowName === BACKOFFICE_PI_WORKFLOW_NAME) {
            if (!model) {
              model = await resolveDefaultBackofficePiModel(pi.models);
            }
            if (!model) {
              return error(
                {
                  message: "No configured Pi model is available.",
                  code: "WORKFLOW_PARAMS_INVALID",
                },
                400,
              );
            }

            const message = validateBackofficePiModel(pi.models, model);
            if (message) {
              return error({ message, code: "WORKFLOW_PARAMS_INVALID" }, 400);
            }
          }

          const authorizationResponse = await authorize(BACKOFFICE_PERMISSION.pi.modify, {
            kind: "pi-session-create",
            workflowName: pathParams.workflowName,
            model,
          });
          if (authorizationResponse || !requestContext) {
            return authorizationResponse;
          }

          const billingOrganizationId = piSessionBillingOrganizationId(values.metadata);
          if (requestContext.scope.kind === "user") {
            if (!billingOrganizationId) {
              return error(
                {
                  message: "User-scoped Pi sessions require a billing organization.",
                  code: "WORKFLOW_PARAMS_INVALID",
                },
                400,
              );
            }
            const billingAuthorizationResponse = await authorize(
              BACKOFFICE_PERMISSION.pi.modify,
              {
                kind: "pi-session-billing-organization",
                workflowName: pathParams.workflowName,
                organizationId: billingOrganizationId,
              },
              {
                ...requestContext,
                scope: { kind: "org", orgId: billingOrganizationId },
              },
            );
            if (billingAuthorizationResponse) {
              return billingAuthorizationResponse;
            }
          }

          const {
            [PI_BILLING_ORGANIZATION_ID_METADATA_KEY]: _requestedBillingOrganizationId,
            ...sessionMetadata
          } = values.metadata ?? {};
          requestState.setBody({
            ...values,
            metadata: {
              ...sessionMetadata,
              model,
              ...(requestContext.scope.kind === "user" && billingOrganizationId
                ? { [PI_BILLING_ORGANIZATION_ID_METADATA_KEY]: billingOrganizationId }
                : {}),
              [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: automationActorsSchema.parse(
                requestContext.actors,
              ),
            },
          });
          return undefined;
        },
      );
      if (createResponse) {
        return createResponse;
      }

      const readRoutes = [
        "/workflows/:workflowName/sessions",
        "/workflows/:workflowName/sessions/:sessionId",
        "/workflows/:workflowName/sessions/:sessionId/export/pi-jsonl",
        "/workflows/:workflowName/sessions/:sessionId/wait-for-agent-end",
      ] as const;
      for (const route of readRoutes) {
        const response = await ifMatchesRoute(
          "GET",
          route,
          async ({ pathParams }, _output) =>
            await authorize(BACKOFFICE_PERMISSION.pi.read, {
              kind: pathParams.sessionId ? "pi-session" : "pi-session-list",
              workflowName: pathParams.workflowName,
              sessionId: pathParams.sessionId,
            }),
        );
        if (response) {
          return response;
        }
      }

      return await ifMatchesRoute(
        "POST",
        "/workflows/:workflowName/sessions/:sessionId/command",
        async ({ pathParams }) =>
          await authorize(BACKOFFICE_PERMISSION.pi.modify, {
            kind: "pi-session",
            workflowName: pathParams.workflowName,
            sessionId: pathParams.sessionId,
          }),
      );
    });

  return {
    workflows: pi.workflows,
    createFragment,
  };
};

export { createPiRouteRuntime } from "../runtime-tools/families/pi-runtime";
