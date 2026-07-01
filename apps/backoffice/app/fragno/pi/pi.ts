import type { PiSkillRegistryResolver } from "@fragno-dev/pi-fragment/skills";
import { Type, type TSchema } from "typebox";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import {
  createPi,
  createPiFragment,
  createPiWorkflows,
  interactiveChatWorkflow,
  type PiBuilder,
  type PiSystemPromptResolver,
  type PiTool,
} from "@fragno-dev/pi-fragment";
import { buildCodemodeWorkflowGraph } from "@fragno-dev/workflow-visualizer";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";

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
  PI_MODEL_CATALOG,
  PI_PROVIDER_TO_MODEL_PROVIDER,
  PI_TOOL_IDS,
  createPiAgentName,
  resolvePiHarnesses,
  type PiHarnessConfig,
  type PiToolId,
  type StoredPiConfig,
} from "./pi-shared";
import { loadBackofficePiSkills } from "./pi-skills";
import { withSinclairSchema } from "./typebox-compat";

export type PiRuntimeFragments = {
  piFragment: ReturnType<typeof createPiFragment>;
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
      "Read a file from the combined Pi session filesystem. Use this to load matching skills from /system/skills/<skill-name>/SKILL.md or /workspace/skills/<skill-name>/SKILL.md before applying them.",
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
                code,
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

      return {
        content: [{ type: "text", text }],
        details: {
          ...result,
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
  });

  cache.set(sessionId, pendingFileSystem);

  try {
    return await pendingFileSystem;
  } catch (error) {
    cache.delete(sessionId);
    throw error;
  }
};

export const createPiToolRegistry = ({
  sessionFileSystems,
  sessionFileSystemContext,
  env,
  codemode,
  bashCommandContext,
}: {
  sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
  sessionFileSystemContext: PiSessionFileSystemContext;
  env?: CloudflareEnv;
  codemode?: PiCodemodeRuntime;
  bashCommandContext?: PiBashCommandContext;
}): Record<PiToolId, PiTool> => ({
  read: async ({ session }) => {
    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createReadTool(fileSystem);
  },
  bash: async ({ session }) => {
    if (!bashCommandContext || !env) {
      throw new Error("bash is not configured for this Pi runtime.");
    }

    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createBashTool(fileSystem, session.id, bashCommandContext);
  },
  execCodeMode: async ({ session }) => {
    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createExecCodeModeTool(
      fileSystem,
      session.id,
      codemode,
      bashCommandContext,
      sessionFileSystemContext.orgId,
    );
  },
});

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

const createBackofficePiBuilder = (tools: Record<PiToolId, PiTool>) =>
  createPi()
    .withTool("bash", tools.bash)
    .withTool("execCodeMode", tools.execCodeMode)
    .withTool("read", tools.read)
    .withWorkflow(interactiveChatWorkflow)
    .logging({ enabled: true, level: "debug" });

type BackofficePiBuilder = PiBuilder<Record<string, never>, Record<PiToolId, PiTool>>;

const buildPiRuntime = (
  config: StoredPiConfig,
  tools: Record<PiToolId, PiTool>,
  skills: PiSkillRegistryResolver,
  resolveSystemPrompt: PiSystemPromptResolver,
) => {
  const builder = createBackofficePiBuilder(tools);

  const harnesses = resolvePiHarnesses(config.harnesses);
  for (const harness of harnesses) {
    registerHarnessAgents(builder, harness, config);
  }

  const runtime = builder.build();

  return {
    config: runtime.config,
    workflows: createPiWorkflows({
      agents: runtime.config.agents,
      tools,
      skills,
      resolveSystemPrompt,
      workflows: runtime.config.workflows,
      logging: runtime.config.logging,
    }),
  };
};

const registerHarnessAgents = (
  builder: BackofficePiBuilder,
  harness: PiHarnessConfig,
  config: StoredPiConfig,
) => {
  for (const option of PI_MODEL_CATALOG) {
    const modelProvider = PI_PROVIDER_TO_MODEL_PROVIDER[option.provider];
    const model = getModel(modelProvider, option.name as never);
    if (!model) {
      console.warn("Pi model missing from registry", {
        provider: option.provider,
        model: option.name,
      });
      continue;
    }

    const agentName = createPiAgentName({
      harnessId: harness.id,
      provider: option.provider,
      model: option.name,
    });

    builder.withAgent(agentName, {
      systemPrompt: harness.systemPrompt,
      model,
      tools: resolveHarnessAgentTools(harness),
      skills: "all",
      toolConfig: harness.toolConfig,
      thinkingLevel: harness.thinkingLevel,
      getApiKey: (provider) => resolveApiKey(config, provider),
    });
  }
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
  const tools = createPiToolRegistry({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
    env: options.env,
    codemode,
    bashCommandContext: options.bashCommandContext,
  });
  const skills: PiSkillRegistryResolver = async ({ sessionId }) => {
    const fileSystem = await getSessionFs(
      options.sessionFileSystems,
      sessionId,
      options.sessionFileSystemContext,
    );
    return loadBackofficePiSkills(fileSystem);
  };
  const resolveSystemPrompt: PiSystemPromptResolver = async ({ sessionId, baseSystemPrompt }) => {
    const fileSystem = await getSessionFs(
      options.sessionFileSystems,
      sessionId,
      options.sessionFileSystemContext,
    );
    return `${baseSystemPrompt}\n\n${await renderCodemodeSystemPrompt({ fileSystem })}`;
  };
  const pi = buildPiRuntime(options.config, tools, skills, resolveSystemPrompt);

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

  const piFragment = createPiFragment(
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
