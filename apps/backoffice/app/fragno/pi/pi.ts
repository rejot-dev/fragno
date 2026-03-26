import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/cloudflare-do";
import type { DurableHooksDispatcherDurableObjectHandler } from "@fragno-dev/db/dispatchers/cloudflare-do";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import {
  createPi,
  createPiFragment,
  createPiWorkflows,
  defineAgent,
  type PiToolRegistry,
} from "@fragno-dev/pi-fragment";
import { createWorkflowsFragment, type WorkflowLiveStateStore } from "@fragno-dev/workflows";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

import { createMasterFileSystem, type FilesContext, type MasterFileSystem } from "@/files";
import type { UploadAdminConfigResponse } from "@/fragno/upload";

import {
  createRouteBackedAutomationsBashRuntime,
  type AutomationsBashRuntime,
} from "../bash-runtime/automations-bash-runtime";
import { createBashHost, EMPTY_BASH_HOST_CONTEXT } from "../bash-runtime/bash-host";
import { createOtpBashRuntime, type OtpBashRuntime } from "../bash-runtime/otp-bash-runtime";
import { createPiRouteBashRuntime, type PiBashRuntime } from "../bash-runtime/pi-bash-runtime";
import {
  createResendRouteBashRuntime,
  type ResendBashRuntime,
} from "../bash-runtime/resend-bash-runtime";
import {
  createTelegramBashRuntime,
  type TelegramBashRuntime,
} from "../bash-runtime/telegram-bash-runtime";
import { bashParametersSchema } from "./pi-schema";
import {
  PI_MODEL_CATALOG,
  PI_PROVIDER_TO_MODEL_PROVIDER,
  PI_TOOL_IDS,
  createPiAgentName,
  resolvePiHarnesses,
  type PiHarnessConfig,
  type StoredPiConfig,
} from "./pi-shared";

export type PiRuntimeFragments = {
  piFragment: ReturnType<typeof createPiFragment>;
  workflowsFragment: ReturnType<typeof createWorkflowsFragment>;
  dispatcher: DurableHooksDispatcherDurableObjectHandler | null;
};

export type PiBashCommandContext = {
  automation: null;
  automations: {
    runtime: AutomationsBashRuntime;
  };
  otp: {
    runtime: OtpBashRuntime;
  };
  pi: {
    runtime: PiBashRuntime;
  };
  resend: {
    runtime: ResendBashRuntime;
  };
  telegram: {
    runtime: TelegramBashRuntime;
  };
};

export type PiSessionUploadRuntime = NonNullable<FilesContext["uploadRuntime"]> & {
  uploadConfig: UploadAdminConfigResponse | null;
};

export type PiSessionResendRuntime = NonNullable<FilesContext["resendRuntime"]>;

export type PiSessionFileSystemContext = {
  orgId: string;
  uploadRuntime: PiSessionUploadRuntime;
  resendRuntime?: PiSessionResendRuntime;
};

function createPiAdapter(state: DurableObjectState) {
  return new SqlAdapter({
    dialect: new DurableObjectDialect({ ctx: state }),
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

const createBashTool = (
  fs: MasterFileSystem,
  sessionId: string,
  bashCommandContext?: PiBashCommandContext,
): AgentTool => ({
  name: "bash",
  label: "Bash",
  description: "Execute bash commands in the combined Pi session filesystem.",
  parameters: bashParametersSchema,
  execute: async (_toolCallId, params, signal) => {
    const { script, cwd } = params as { script: string; cwd?: string };
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

    const { bash, commandCallsResult } = createBashHost({
      fs,
      sessionId,
      context: bashCommandContext ?? EMPTY_BASH_HOST_CONTEXT,
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

const getSessionFs = async (
  cache: Map<string, Promise<MasterFileSystem>>,
  sessionId: string,
  context: PiSessionFileSystemContext,
) => {
  const existing = cache.get(sessionId);
  if (existing) {
    return existing;
  }

  const pendingFileSystem = createMasterFileSystem({
    orgId: context.orgId,
    origin: context.uploadRuntime.baseUrl,
    backend: "pi",
    uploadConfig: context.uploadRuntime.uploadConfig,
    uploadRuntime: context.uploadRuntime,
    resendRuntime: context.resendRuntime,
  });

  cache.set(sessionId, pendingFileSystem);

  try {
    return await pendingFileSystem;
  } catch (error) {
    cache.delete(sessionId);
    throw error;
  }
};

export const createPiToolRegistry = (
  sessionFileSystems: Map<string, Promise<MasterFileSystem>>,
  sessionFileSystemContext: PiSessionFileSystemContext,
  bashCommandContext?: PiBashCommandContext,
): PiToolRegistry => ({
  bash: async ({ session }) => {
    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createBashTool(fileSystem, session.id, bashCommandContext);
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

const buildPiRuntime = (config: StoredPiConfig, tools: PiToolRegistry) => {
  const builder = createPi().tools(tools).defaultSteeringMode("one-at-a-time");

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
      toolSideEffectReducers: runtime.config.toolSideEffectReducers,
      logging: runtime.config.logging,
    }),
  };
};

const registerHarnessAgents = (
  builder: ReturnType<typeof createPi>,
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

    builder.agent(
      defineAgent(agentName, {
        systemPrompt: harness.systemPrompt,
        model,
        tools: harness.tools,
        toolConfig: harness.toolConfig,
        thinkingLevel: harness.thinkingLevel,
        getApiKey: (provider) => resolveApiKey(config, provider),
      }),
    );
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
}): PiBashCommandContext => ({
  automation: null,
  automations: {
    runtime: createRouteBackedAutomationsBashRuntime({ env, orgId }),
  },
  otp: {
    runtime: createOtpBashRuntime({ env, orgId }),
  },
  pi: {
    runtime: createPiRouteBashRuntime({ env, orgId }),
  },
  resend: {
    runtime: createResendRouteBashRuntime({ env, orgId }),
  },
  telegram: {
    runtime: createTelegramBashRuntime({ env, orgId }),
  },
});

export const createPiRuntime = (options: {
  config: StoredPiConfig;
  state: DurableObjectState;
  env: CloudflareEnv;
  sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
  sessionFileSystemContext: PiSessionFileSystemContext;
  liveStateStore: WorkflowLiveStateStore;
  bashCommandContext: PiBashCommandContext;
}): PiRuntimeFragments => {
  const adapter = createPiAdapter(options.state);
  const tools = createPiToolRegistry(
    options.sessionFileSystems,
    options.sessionFileSystemContext,
    options.bashCommandContext,
  );
  const pi = buildPiRuntime(options.config, tools);

  const workflowsFragment = createWorkflowsFragment(
    {
      workflows: pi.workflows,
      liveState: options.liveStateStore,
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

  const dispatcher = createDurableHooksProcessor<CloudflareEnv>([workflowsFragment, piFragment], {
    onProcessError: (error) => {
      console.error("Pi hook processor error", error);
    },
  })(options.state, options.env);

  return {
    piFragment,
    workflowsFragment,
    dispatcher,
  };
};

export { createPiRouteBashRuntime } from "../bash-runtime/pi-bash-runtime";
