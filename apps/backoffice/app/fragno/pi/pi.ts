import { createPiHarness, createPiWorkflows } from "@fragno-dev/pi-harness/factory";
import { NoOpExecutionEnv } from "@fragno-dev/pi-harness/harness/execution-env";
import type { PiSkillDefinition, PiSkillRegistryResolver } from "@fragno-dev/pi-harness/skills";
import type { PiFragmentConfig } from "@fragno-dev/pi-harness/types";
import {
  createInteractiveChatWorkflow,
  type InteractiveChatWorkflowParams,
} from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import type { WorkflowRegistryEntry } from "@fragno-dev/workflows/workflow";
import { Type, type TSchema } from "typebox";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { buildCodemodeWorkflowGraph } from "@fragno-dev/workflow-visualizer";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import {
  formatSkillsForSystemPrompt,
  type AgentTool,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { getModels } from "@earendil-works/pi-ai";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeDatabaseAdapterFactory } from "@/backoffice-runtime/database-adapters";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { createBackofficeFileSystem, type MasterFileSystem } from "@/files";
import { PI_CODEMODE_WORKFLOW } from "@/fragno/automation/engine/workflow-start";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";

import type {
  BackofficeCodemodeEnv,
  BackofficeCodemodeExecuteResult,
  RunBackofficeCodemodeInput,
} from "../codemode/execute";
import { createInteractiveBashHost } from "../runtime-tools/automation-host";
import type {
  InteractiveBashCommandContext,
  RegisteredAutomationsRuntime,
} from "../runtime-tools/bash-host";
import type {
  AutomationWorkflowRuntime,
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
import type { PiCodemodeWorkflowParams } from "./pi-codemode-workflow";
import {
  parsePiAgentName,
  PI_PROVIDER_TO_MODEL_PROVIDER,
  PI_TOOL_IDS,
  resolvePiHarnesses,
  type PiHarnessConfig,
  type PiToolId,
  type StoredPiConfig,
} from "./pi-shared";
import { loadBackofficePiSkills } from "./pi-skills";
import { withSinclairSchema } from "./typebox-compat";

export type PiRuntimeFragments = {
  piFragment: ReturnType<typeof createPiHarness>;
  workflowsFragment: ReturnType<typeof createWorkflowsFragment>;
};

export type PiBashCommandContext = InteractiveBashCommandContext & {
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
  orgId: string;
  objects: BackofficeObjectRegistry;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  runtimeConfig: import("@/backoffice-runtime/runtime-services").BackofficeRuntimeConfig;
};

export type PiCodemodeRuntime = {
  env: BackofficeCodemodeEnv;
  execute(input: RunBackofficeCodemodeInput): Promise<BackofficeCodemodeExecuteResult>;
  workflow?: AutomationWorkflowRuntime;
};

export const bashParametersSchema = withSinclairSchema(
  Type.Object({
    script: Type.String({
      minLength: 1,
      description: "Shell script or command to execute in the sandboxed environment.",
    }),
    cwd: Type.Optional(
      Type.String({ description: "Optional working directory within the virtual filesystem." }),
    ),
  }),
);

const readParametersSchema = withSinclairSchema(
  Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)." }),
    offset: Type.Optional(
      Type.Number({ description: "Line number to start reading from (1-indexed)." }),
    ),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
  }),
);

const execCodeModeParametersSchema = withSinclairSchema(
  Type.Object({
    code: Type.String({
      minLength: 1,
      description:
        "Standalone async arrow function to execute in an isolated dynamic Worker with state.* filesystem tools.",
    }),
  }),
);

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

const createReadTool = (fs: MasterFileSystem): AgentTool =>
  defineTool({
    name: "read",
    label: "Read",
    description:
      "Read a file from the combined Pi session filesystem. Use this to load matching skills from /static/skills/<skill-name>/SKILL.md or /workspace/skills/<skill-name>/SKILL.md before applying them.",
    parameters: readParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw new Error("Read aborted.");
      }

      const path = normalizeReadPath(params.path);
      const content = await fs.readFile(path, { encoding: "utf-8" });
      const text = applyLineRange(content, params.offset, params.limit);
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

const createBashTool = (
  fs: MasterFileSystem,
  sessionId: string,
  context: PiBashCommandContext,
): AgentTool =>
  defineTool({
    name: "bash",
    label: "Bash",
    description: "Execute bash commands in the combined Pi session filesystem.",
    parameters: bashParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      const { script, cwd } = params;
      if (signal?.aborted) {
        throw new Error("Bash execution aborted.");
      }
      const scriptPreview = script.length > 120 ? `${script.slice(0, 117)}...` : script;
      console.info("Pi bash tool start", {
        sessionId,
        cwd,
        length: script.length,
        preview: scriptPreview,
      });

      const { bash, commandCallsResult } = createInteractiveBashHost({
        fs,
        sessionId,
        context,
      });
      let result: Awaited<ReturnType<typeof bash.exec>>;
      try {
        result = await bash.exec(script, cwd ? { cwd } : { cwd: "/" });
      } catch (error) {
        console.warn("Pi bash tool error", {
          sessionId,
          cwd,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const stdout = result.stdout?.trimEnd() ?? "";
      const stderr = result.stderr?.trimEnd() ?? "";
      const exitCode = result.exitCode ?? 0;

      const outputLines = [stdout, stderr].filter(Boolean);
      if (outputLines.length === 0) {
        outputLines.push(`Command finished with exit code ${exitCode}.`);
      }

      console.info("Pi bash tool end", {
        sessionId,
        exitCode,
      });

      return {
        content: [{ type: "text", text: outputLines.join("\n") }],
        details: {
          stdout,
          stderr,
          exitCode,
          commandCalls: commandCallsResult,
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
  fs: MasterFileSystem,
  sessionId: string,
  codemode: PiCodemodeRuntime | undefined,
  bashCommandContext: PiBashCommandContext | undefined,
  orgId: string,
): AgentTool =>
  defineTool({
    name: "execCodeMode",
    label: "Exec Code Mode",
    description: "Execute JavaScript code in the context of the system.",
    parameters: execCodeModeParametersSchema,
    execute: async (toolCallId, params, signal) => {
      const { code } = params;
      if (signal?.aborted) {
        throw new Error("Codemode execution aborted.");
      }

      if (!codemode) {
        throw new Error("execCodeMode is not configured for this Pi runtime.");
      }

      if (!bashCommandContext) {
        throw new Error("execCodeMode requires a Backoffice runtime context.");
      }

      const context: CoreBackofficeToolContext = createBackofficeToolContext({
        ...bashCommandContext,
        workflow: codemode.workflow ? { runtime: codemode.workflow } : bashCommandContext.workflow,
      });

      const result = await codemode.execute({
        code,
        fs,
        env: codemode.env,
        families: runtimeToolFamilies,
        toolContext: context,
      });

      // When the code defines a workflow, derive its graph here (server-side,
      // where the visualizer's parser is available) — *before* scheduling, since a
      // static parse must survive even when the durable run can't be created. A
      // plain script run carries no `workflowDefinition`; the client flags it and
      // shows the code + output instead of the graph (see `codemodeEntryFromResult`).
      const workflowGraph = buildCodemodeWorkflowGraph(code, {
        name: result.workflowDefinition?.name,
      });
      const parsedWorkflow = workflowGraph.nodes.some((node) => node.kind === "workflow");

      // Try to schedule the durable run, but treat a scheduling/validation failure
      // as non-fatal: the viewer should still show the workflow the agent wrote.
      let scheduleError: string | undefined;
      // The scheduled run's handle, surfaced to the client so the workflow viewer
      // can subscribe to its live progress (history/status + step emissions).
      let runHandle: WorkflowCreateInstanceResult | undefined;
      if (result.workflowDefinition) {
        if (!codemode.workflow) {
          scheduleError = "execCodeMode workflow definition cannot be scheduled in this runtime.";
        } else {
          try {
            const instanceId = hashToolCallId(`${sessionId}--${toolCallId}`);
            runHandle = await codemode.workflow.createInstance({
              workflowName: PI_CODEMODE_WORKFLOW,
              remoteWorkflowName: result.workflowDefinition.name,
              instanceId,
              params: {
                orgId,
                code: result.preparedCode ?? code,
                ...(result.preparedModules ? { modules: result.preparedModules } : {}),
                sessionId,
                toolCallId: toolCallId,
              } satisfies PiCodemodeWorkflowParams,
            });
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

      const {
        preparedCode: _preparedCode,
        preparedModules: _preparedModules,
        ...publicResult
      } = result;

      return {
        content: [{ type: "text", text }],
        details: {
          ...publicResult,
          code,
          workflowGraph,
          outputText: text,
          // The live run handle (workflow name + instance id) so the client can
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

type BackofficePiToolFactory = (sessionId: string) => Promise<Partial<Record<PiToolId, AgentTool>>>;

type CreatePiToolFactoryOptions = {
  sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
  sessionFileSystemContext: PiSessionFileSystemContext;
  env?: CloudflareEnv;
  codemode?: PiCodemodeRuntime;
  bashCommandContext?: PiBashCommandContext;
};

export const createPiToolFactory =
  ({
    sessionFileSystems,
    sessionFileSystemContext,
    env,
    codemode,
    bashCommandContext,
  }: CreatePiToolFactoryOptions): BackofficePiToolFactory =>
  async (sessionId) => {
    const fileSystem = await getSessionFs(sessionFileSystems, sessionId, sessionFileSystemContext);

    return {
      read: createReadTool(fileSystem),
      ...(bashCommandContext && env
        ? { bash: createBashTool(fileSystem, sessionId, bashCommandContext) }
        : {}),
      execCodeMode: createExecCodeModeTool(
        fileSystem,
        sessionId,
        codemode,
        bashCommandContext,
        sessionFileSystemContext.orgId,
      ),
    };
  };

export const createPiToolRegistry = (options: CreatePiToolFactoryOptions) => {
  const createTools = createPiToolFactory(options);
  const createSessionTool =
    (toolId: PiToolId) =>
    async (context: { session: { id: string } }): Promise<AgentTool> => {
      const tool = (await createTools(context.session.id))[toolId];
      if (!tool) {
        throw new Error(`${toolId} is not configured for this Pi runtime.`);
      }
      return tool;
    };

  return {
    read: createSessionTool("read"),
    bash: createSessionTool("bash"),
    execCodeMode: createSessionTool("execCodeMode"),
  };
};

const resolveBackofficeModel = (
  provider: keyof typeof PI_PROVIDER_TO_MODEL_PROVIDER,
  modelName: string,
) => {
  const modelProvider = PI_PROVIDER_TO_MODEL_PROVIDER[provider];
  return getModels(modelProvider).find(
    (model) => model.name === modelName || model.id === modelName,
  );
};

const resolveApiKey = (config: StoredPiConfig, provider: string): string | undefined => {
  switch (provider) {
    case "openai":
      return config.apiKeys.openai;
    case "anthropic":
      return config.apiKeys.anthropic;
    case "google":
      return config.apiKeys.gemini;
    default:
      return undefined;
  }
};

const createBackofficePiSkillResolver =
  (options: {
    sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
    sessionFileSystemContext: PiSessionFileSystemContext;
  }): PiSkillRegistryResolver =>
  async ({ sessionId }) => {
    const fileSystem = await getSessionFs(
      options.sessionFileSystems,
      sessionId,
      options.sessionFileSystemContext,
    );
    return loadBackofficePiSkills(fileSystem);
  };

type BackofficeSystemPromptResolver = (options: {
  sessionId: string;
  baseSystemPrompt: string;
}) => Promise<string>;

const createBackofficeSystemPromptResolver =
  (options: {
    sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
    sessionFileSystemContext: PiSessionFileSystemContext;
  }): BackofficeSystemPromptResolver =>
  async ({ sessionId, baseSystemPrompt }) => {
    const fileSystem = await getSessionFs(
      options.sessionFileSystems,
      sessionId,
      options.sessionFileSystemContext,
    );
    return `${baseSystemPrompt}\n\n${await renderCodemodeSystemPrompt({ fileSystem })}`;
  };

const toAgentSkill = (skill: PiSkillDefinition): Skill => ({
  name: skill.name,
  description: skill.description,
  content: skill.body ?? "",
  filePath: skill.location ?? `${skill.directory ?? "/skills"}/${skill.name}/SKILL.md`,
});

const buildSystemPrompt = async (
  harness: PiHarnessConfig,
  params: Pick<InteractiveChatWorkflowParams, "systemPrompt">,
  skills: Skill[],
  resolveSystemPrompt: BackofficeSystemPromptResolver,
  sessionId: string,
) => {
  const baseSystemPrompt = [
    params.systemPrompt ?? harness.systemPrompt,
    formatSkillsForSystemPrompt(skills),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return await resolveSystemPrompt({ sessionId, baseSystemPrompt });
};

const resolveHarnessAgentTools = (harness: PiHarnessConfig): PiToolId[] => {
  const tools = harness.tools.filter(isValidPiToolId);
  if (tools.includes("read")) {
    return tools;
  }
  return [...tools, "read"];
};

const isValidPiToolId = (toolId: string): toolId is (typeof PI_TOOL_IDS)[number] =>
  PI_TOOL_IDS.includes(toolId as (typeof PI_TOOL_IDS)[number]);

const createBackofficeInteractiveChatWorkflow = ({
  config,
  createTools,
  skills,
  resolveSystemPrompt,
}: {
  config: StoredPiConfig;
  createTools: BackofficePiToolFactory;
  skills: PiSkillRegistryResolver;
  resolveSystemPrompt: BackofficeSystemPromptResolver;
}): WorkflowRegistryEntry =>
  createInteractiveChatWorkflow({
    commandTimeout: "1 hour",
    resolveHarness: async (params, context) => {
      const requestedAgentName = params.harnessName ?? "default";
      const parsedAgentName = parsePiAgentName(requestedAgentName);
      const harnessId = parsedAgentName?.harnessId ?? requestedAgentName;
      const harness = resolvePiHarnesses(config.harnesses).find((entry) => entry.id === harnessId);
      if (!harness) {
        throw new Error(`Harness ${harnessId} not found.`);
      }

      const model = parsedAgentName
        ? resolveBackofficeModel(parsedAgentName.provider, parsedAgentName.model)
        : params.model;
      if (!model) {
        throw new Error(
          parsedAgentName
            ? `Model ${parsedAgentName.provider}/${parsedAgentName.model} not found.`
            : "INTERACTIVE_CHAT_MODEL_REQUIRED",
        );
      }

      const apiKey = resolveApiKey(config, model.provider);
      if (!apiKey) {
        throw new Error(`API key for provider ${model.provider} is not configured.`);
      }

      const sessionTools = await createTools(context.sessionId);
      const activeTools = resolveHarnessAgentTools(harness).map((toolId) => {
        const tool = sessionTools[toolId];
        if (!tool) {
          throw new Error(`${toolId} is not configured for this Pi runtime.`);
        }
        return tool;
      });
      const agentSkills = Object.values(
        await skills({
          agentName: requestedAgentName,
          workflowName: context.workflowName,
          sessionId: context.sessionId,
          turnId: "initial",
        }),
      ).map(toAgentSkill);

      return {
        harnessName: requestedAgentName,
        env: new NoOpExecutionEnv(),
        model,
        thinkingLevel: params.thinkingLevel ?? harness.thinkingLevel,
        systemPrompt: await buildSystemPrompt(
          harness,
          params,
          agentSkills,
          resolveSystemPrompt,
          context.sessionId,
        ),
        resources: { skills: agentSkills },
        tools: activeTools,
        getApiKeyAndHeaders: async (requestModel) => {
          const requestApiKey = resolveApiKey(config, requestModel.provider);
          return requestApiKey ? { apiKey: requestApiKey } : undefined;
        },
      };
    },
  });

const buildPiRuntime = (
  config: StoredPiConfig,
  createTools: BackofficePiToolFactory,
  skills: PiSkillRegistryResolver,
  resolveSystemPrompt: BackofficeSystemPromptResolver,
) => {
  const workflows = [
    createBackofficeInteractiveChatWorkflow({ config, createTools, skills, resolveSystemPrompt }),
  ];
  const piConfig = {
    workflows,
    logging: { enabled: true, level: "debug" },
  } satisfies PiFragmentConfig;

  return {
    config: piConfig,
    workflows: createPiWorkflows(piConfig),
  };
};

export const createPiRuntime = (options: {
  config: StoredPiConfig;
  adapters: BackofficeDatabaseAdapterFactory;
  orgId: string;
  env: CloudflareEnv;
  sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
  sessionFileSystemContext: PiSessionFileSystemContext;
  bashCommandContext: PiBashCommandContext;
  codemode: PiCodemodeRuntime;
}): PiRuntimeFragments => {
  const adapter = options.adapters.createAdapter({
    kind: "pi",
  });
  const codemode = options.codemode;
  const createTools = createPiToolFactory({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
    env: options.env,
    codemode,
    bashCommandContext: options.bashCommandContext,
  });
  const skills = createBackofficePiSkillResolver({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
  });
  const resolveSystemPrompt = createBackofficeSystemPromptResolver({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
  });
  const pi = buildPiRuntime(options.config, createTools, skills, resolveSystemPrompt);

  const workflowsFragment = createWorkflowsFragment(
    {
      workflows: pi.workflows,
      runtime: defaultFragnoRuntime,
    },
    {
      databaseAdapter: adapter,
      mountRoute: "/api/pi-workflows",
    },
  );

  const piFragment = createPiHarness(
    pi.config,
    {
      databaseAdapter: adapter,
      mountRoute: "/api/pi",
    },
    {
      workflows: workflowsFragment.services,
    },
  );

  return {
    piFragment,
    workflowsFragment,
  };
};

export { createPiRouteRuntime } from "../runtime-tools/families/pi-runtime";
