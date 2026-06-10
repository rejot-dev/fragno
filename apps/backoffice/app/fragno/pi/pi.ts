import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import type { PiSkillRegistryResolver } from "@fragno-dev/pi-fragment/skills";
import { Type, type TSchema } from "typebox";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import {
  createPi,
  createPiFragment,
  createPiWorkflows,
  interactiveChatWorkflow,
  type PiBuilder,
  type PiTool,
} from "@fragno-dev/pi-fragment";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";

import { createOrgFileSystem, type MasterFileSystem } from "@/files";

import type {
  BackofficeCodemodeEnv,
  BackofficeCodemodeExecuteResult,
  RunBackofficeCodemodeInput,
} from "../codemode/execute";
import { createInteractiveBashHost } from "../runtime-tools/automation-host";
import type { InteractiveBashCommandContext } from "../runtime-tools/bash-host";
import type { AutomationStoreRuntime } from "../runtime-tools/families/automations-bindings";
import type { AutomationWorkflowRuntime } from "../runtime-tools/families/automations-workflow";
import type { OtpRuntime } from "../runtime-tools/families/otp-runtime";
import type { PiRuntime } from "../runtime-tools/families/pi";
import type { ResendRuntime } from "../runtime-tools/families/resend";
import type { Reson8Runtime } from "../runtime-tools/families/reson8";
import type { TelegramRuntime } from "../runtime-tools/families/telegram-runtime";
import { createRouteBackedRuntimeContext } from "../runtime-tools/route-backed-runtime-context";
import {
  getAvailableRuntimeTools,
  type BackofficeToolContext,
} from "../runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "../runtime-tools/tool-context";
import { runtimeToolFamilies } from "../runtime-tools/tool-families";
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
    runtime: AutomationStoreRuntime;
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
  env: Pick<CloudflareEnv, "UPLOAD" | "RESEND" | "AUTOMATIONS">;
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

export const readParametersSchema = withSinclairSchema(
  Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)." }),
    offset: Type.Optional(
      Type.Number({ description: "Line number to start reading from (1-indexed)." }),
    ),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
  }),
);

export const execCodeModeParametersSchema = withSinclairSchema(
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

function createPiAdapter(state: DurableObjectState) {
  return new SqlAdapter({
    dialect: new DurableObjectDialect({ ctx: state }),
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

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
      "Read a file from the combined Pi session filesystem. Use this to load matching skills from /starter/skills/<skill-name>/SKILL.md before applying them.",
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
  env: CloudflareEnv,
  orgId: string,
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
        env,
        orgId,
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
    description:
      "Execute a standalone async arrow function in an isolated dynamic Worker with state.* filesystem tools.",
    parameters: execCodeModeParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      const { code } = params;
      if (signal?.aborted) {
        throw new Error("Codemode execution aborted.");
      }

      if (!codemode) {
        throw new Error("execCodeMode is not configured for this Pi runtime.");
      }

      const context: BackofficeToolContext = bashCommandContext
        ? createBackofficeToolContext({
            ...bashCommandContext,
            workflow: codemode.workflow
              ? { runtime: codemode.workflow }
              : bashCommandContext.workflow,
          })
        : { runtimes: { workflow: codemode.workflow } };

      const tools = getAvailableRuntimeTools({
        families: runtimeToolFamilies,
        context,
      });

      const result = await codemode.execute({
        code,
        fs,
        env: codemode.env,
        tools,
        context,
      });

      if (result.workflowDefinition) {
        if (!codemode.workflow) {
          throw new Error("execCodeMode workflow definition cannot be scheduled in this runtime.");
        }
        result.result = await codemode.workflow.createInstance({
          workflowName: "pi-codemode-script",
          remoteWorkflowName: result.workflowDefinition.name,
          instanceId: `${sessionId}--${_toolCallId}`,
          params: {
            code,
            sessionId,
            toolCallId: _toolCallId,
            orgId,
          } satisfies PiCodemodeWorkflowParams,
        });
      }

      const text = formatExecCodeModeText(result);

      if (result.error) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: result,
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

  const pendingFileSystem = createOrgFileSystem({
    orgId: context.orgId,
    env: context.env,
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
    return createBashTool(
      fileSystem,
      session.id,
      bashCommandContext,
      env,
      sessionFileSystemContext.orgId,
    );
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

const buildPiRuntime = (
  config: StoredPiConfig,
  tools: Record<PiToolId, PiTool>,
  skills: PiSkillRegistryResolver,
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
      tools: runtime.config.tools,
      skills,
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

export const isValidPiToolId = (toolId: string): toolId is (typeof PI_TOOL_IDS)[number] =>
  PI_TOOL_IDS.includes(toolId as (typeof PI_TOOL_IDS)[number]);

export const createPiBashCommandContext = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): PiBashCommandContext => createRouteBackedRuntimeContext({ env, orgId });

export const createPiRuntime = (options: {
  config: StoredPiConfig;
  state: DurableObjectState;
  env: CloudflareEnv;
  sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
  sessionFileSystemContext: PiSessionFileSystemContext;
  bashCommandContext: PiBashCommandContext;
  codemode?: PiCodemodeRuntime;
}): PiRuntimeFragments => {
  const adapter = createPiAdapter(options.state);
  const codemode = options.codemode;
  const tools = createPiToolRegistry({
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
  const pi = buildPiRuntime(options.config, tools, skills);

  const workflowsFragment = createWorkflowsFragment(
    {
      workflows: pi.workflows,
      runtime: defaultFragnoRuntime,
    },
    {
      databaseAdapter: adapter,
      mountRoute: "/api/workflows",
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
