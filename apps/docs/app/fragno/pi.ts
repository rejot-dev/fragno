import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/cloudflare-do";
import type { DurableHooksDispatcherDurableObjectHandler } from "@fragno-dev/db/dispatchers/cloudflare-do";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { Bash, InMemoryFs } from "just-bash";

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

import { bashParametersSchema } from "./pi-schema";
import {
  PI_MODEL_CATALOG,
  PI_PROVIDER_TO_MODEL_PROVIDER,
  PI_TOOL_IDS,
  createPiAgentName,
  resolvePiHarnesses,
  type PiHarnessConfig,
  type PiModelProvider,
  type StoredPiConfig,
} from "./pi-shared";

export type PiRuntimeFragments = {
  piFragment: ReturnType<typeof createPiFragment>;
  workflowsFragment: ReturnType<typeof createWorkflowsFragment>;
  dispatcher: DurableHooksDispatcherDurableObjectHandler | null;
};

export function createPiAdapter(state: DurableObjectState) {
  return new SqlAdapter({
    dialect: new DurableObjectDialect({ ctx: state }),
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

const createBashTool = (fs: InMemoryFs, sessionId: string): AgentTool => ({
  name: "bash",
  label: "Bash",
  description: "Execute bash commands in an isolated in-memory filesystem.",
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

    const bash = new Bash({ fs });
    let result: Awaited<ReturnType<typeof bash.exec>>;
    try {
      result = await bash.exec(script, cwd ? { cwd } : {});
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
      },
    };
  },
});

const getSessionFs = (cache: Map<string, InMemoryFs>, sessionId: string) => {
  const existing = cache.get(sessionId);
  if (existing) {
    return existing;
  }
  const fs = new InMemoryFs();
  cache.set(sessionId, fs);
  return fs;
};

export const createPiToolRegistry = (
  sessionFileSystems: Map<string, InMemoryFs>,
): PiToolRegistry => ({
  bash: ({ session }) => {
    const fs = getSessionFs(sessionFileSystems, session.id);
    return createBashTool(fs, session.id);
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

export const isValidPiModelOption = (
  provider: PiModelProvider,
  model: string,
): model is (typeof PI_MODEL_CATALOG)[number]["name"] =>
  PI_MODEL_CATALOG.some((option) => option.provider === provider && option.name === model);

export const createPiRuntime = (options: {
  config: StoredPiConfig;
  state: DurableObjectState;
  env: CloudflareEnv;
  sessionFileSystems: Map<string, InMemoryFs>;
  liveStateStore: WorkflowLiveStateStore;
}): PiRuntimeFragments => {
  const adapter = createPiAdapter(options.state);
  const tools = createPiToolRegistry(options.sessionFileSystems);
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
