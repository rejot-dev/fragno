import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { Type, type TSchema } from "typebox";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import {
  createPi,
  createPiFragment,
  createPiWorkflows,
  interactiveChatWorkflow,
  type PiTool,
} from "@fragno-dev/pi-fragment";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";

import { createOrgFileSystem, type MasterFileSystem } from "@/files";

import {
  createInteractiveBashHost,
  createRouteBackedInteractiveBashContext,
  type InteractiveBashCommandContext,
} from "../bash-runtime/bash-host";
import type { OtpBashRuntime } from "../bash-runtime/otp-bash-runtime";
import type { PiBashRuntime } from "../bash-runtime/pi-bash-runtime";
import type { ResendBashRuntime } from "../bash-runtime/resend-bash-runtime";
import type { Reson8BashRuntime } from "../bash-runtime/reson8-bash-runtime";
import type { TelegramBashRuntime } from "../bash-runtime/telegram-bash-runtime";
import type {
  BackofficeCodemodeEnv,
  BackofficeCodemodeExecuteResult,
  RunBackofficeCodemodeInput,
} from "../codemode/execute";
import {
  automationIdentityRuntimeTools,
  type AutomationsRuntime,
} from "../runtime-tools/families/automations";
import { otpRuntimeTools } from "../runtime-tools/families/otp";
import { telegramRuntimeTools } from "../runtime-tools/families/telegram";
import type {
  AnyBackofficeRuntimeTool,
  BackofficeToolContext,
} from "../runtime-tools/runtime-tools";
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
import { withSinclairSchema } from "./typebox-compat";

export type PiRuntimeFragments = {
  piFragment: ReturnType<typeof createPiFragment>;
  workflowsFragment: ReturnType<typeof createWorkflowsFragment>;
};

export type PiBashCommandContext = InteractiveBashCommandContext & {
  automations: {
    runtime: AutomationsRuntime;
  };
  otp: {
    runtime: OtpBashRuntime;
  };
  pi: {
    runtime: PiBashRuntime;
  };
  reson8: {
    runtime: Reson8BashRuntime;
  };
  resend: {
    runtime: ResendBashRuntime;
  };
  telegram: {
    runtime: TelegramBashRuntime;
  };
};

export type PiSessionFileSystemContext = {
  orgId: string;
  env: Pick<CloudflareEnv, "UPLOAD" | "RESEND" | "AUTOMATIONS">;
};

type PiCodemodeToolContext = BackofficeToolContext<{
  automations?: AutomationsRuntime;
  otp?: OtpBashRuntime;
  telegram?: TelegramBashRuntime;
}>;

export type PiCodemodeRuntime = {
  env: BackofficeCodemodeEnv;
  execute(input: RunBackofficeCodemodeInput): Promise<BackofficeCodemodeExecuteResult>;
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
  codemode: PiCodemodeRuntime | undefined,
  bashCommandContext: PiBashCommandContext | undefined,
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

      const tools: AnyBackofficeRuntimeTool<PiCodemodeToolContext>[] = [
        ...automationIdentityRuntimeTools,
        ...(bashCommandContext?.otp ? otpRuntimeTools : []),
        ...(bashCommandContext?.telegram ? telegramRuntimeTools : []),
      ];
      const context: PiCodemodeToolContext = {
        runtimes: {
          automations: bashCommandContext?.automations.runtime,
          otp: bashCommandContext?.otp?.runtime,
          telegram: bashCommandContext?.telegram?.runtime,
        },
      };

      const result = await codemode.execute({
        code,
        fs,
        env: codemode.env,
        tools,
        context,
      });

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
    return createExecCodeModeTool(fileSystem, codemode, bashCommandContext);
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
    .withWorkflow(interactiveChatWorkflow)
    .logging({ enabled: true, level: "debug" });

type BackofficePiBuilder = ReturnType<typeof createBackofficePiBuilder>;

const buildPiRuntime = (config: StoredPiConfig, tools: Record<PiToolId, PiTool>) => {
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
      tools: harness.tools.filter(isValidPiToolId),
      toolConfig: harness.toolConfig,
      thinkingLevel: harness.thinkingLevel,
      getApiKey: (provider) => resolveApiKey(config, provider),
    });
  }
};

export const isValidPiToolId = (toolId: string): toolId is (typeof PI_TOOL_IDS)[number] =>
  PI_TOOL_IDS.includes(toolId as (typeof PI_TOOL_IDS)[number]);

export const createPiBashCommandContext = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): PiBashCommandContext => createRouteBackedInteractiveBashContext({ env, orgId });

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
  const tools = createPiToolRegistry({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
    env: options.env,
    codemode: options.codemode,
    bashCommandContext: options.bashCommandContext,
  });
  const pi = buildPiRuntime(options.config, tools);

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

export { createPiRouteBashRuntime } from "../bash-runtime/pi-bash-runtime";
