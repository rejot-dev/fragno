import { BASH_HARNESS_REFERENCE, SYSTEM_FILE_CONTENT, SYSTEM_GUIDANCE } from "@/files";

import { createCodemodeSystemPrompt } from "../codemode/state-prompt";
import { piCodemodeRuntimeToolFamilies } from "../runtime-tools/tool-families";

export type PiSteeringMode = "all" | "one-at-a-time";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type PiModelProvider = "openai" | "anthropic" | "gemini";

export type PiModelOption = {
  provider: PiModelProvider;
  name: string;
  label: string;
};

export type PiHarnessConfig = {
  id: string;
  label: string;
  description?: string;
  systemPrompt: string;
  tools: string[];
  thinkingLevel?: PiThinkingLevel;
  steeringMode?: PiSteeringMode;
  toolConfig?: unknown;
};

export type StoredPiConfig = {
  orgId: string;
  apiKeys: {
    openai?: string;
    anthropic?: string;
    gemini?: string;
  };
  harnesses: PiHarnessConfig[];
  createdAt: string;
  updatedAt: string;
};

export type PiConfigState = {
  configured: boolean;
  config?: {
    orgId: string;
    apiKeys: {
      openai?: string | null;
      anthropic?: string | null;
      gemini?: string | null;
    };
    harnesses: PiHarnessConfig[];
    createdAt: string;
    updatedAt: string;
  };
};

export const PI_PROVIDER_LABELS: Record<PiModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

export const PI_PROVIDER_TO_MODEL_PROVIDER = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
} as const satisfies Record<PiModelProvider, string>;

const DEFAULT_SYSTEM_PROMPT = (() => {
  const systemFile = SYSTEM_FILE_CONTENT["SYSTEM.md"];
  const fallback = SYSTEM_GUIDANCE;

  if (typeof systemFile === "string") {
    return systemFile.trim();
  }

  if (systemFile === null || systemFile === undefined) {
    return fallback;
  }

  return new TextDecoder().decode(systemFile).trim();
})();

export const PI_MODEL_CATALOG: PiModelOption[] = [
  { provider: "openai", name: "gpt-5-nano", label: "GPT-5 nano" },
  { provider: "openai", name: "gpt-5-mini", label: "GPT-5 mini" },
  { provider: "openai", name: "gpt-5.2", label: "GPT-5.2" },
  { provider: "openai", name: "gpt-5.2-pro", label: "GPT-5.2 Pro" },
  { provider: "anthropic", name: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { provider: "anthropic", name: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { provider: "anthropic", name: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { provider: "gemini", name: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
  { provider: "gemini", name: "gemini-3-pro-preview", label: "Gemini 3 Pro (Preview)" },
];

export const PI_TOOL_IDS = ["bash", "execCodeMode"] as const;
export type PiToolId = (typeof PI_TOOL_IDS)[number];

const BASH_HARNESS_PROMPT = `SYSTEM.md (agent guidance):\n\n${DEFAULT_SYSTEM_PROMPT}\n\n${BASH_HARNESS_REFERENCE}`;

const STATE_HARNESS_PROMPT = createCodemodeSystemPrompt({
  families: piCodemodeRuntimeToolFamilies,
});

const CODEMODE_HARNESS_PROMPT = `SYSTEM.md (agent guidance):\n\n${DEFAULT_SYSTEM_PROMPT}

Codemode harness guidance:

- Use execCodeMode for coordinated filesystem work in the combined session filesystem.
- Use state.* APIs from inside execCodeMode for multi-file operations.
- Prefer camelCase domain tools when they are available in codemode contexts.
- Do not assume import() or module loading is available inside dynamic Worker code.
- Write codemode automation scripts as standalone async arrow functions, for example: async () => { return await state.readFile("/workspace/file.txt"); }
- Codemode automation script files must use /workspace/automations/scripts/*.cm.js and bindings.json entries must set script.engine to "codemode".
- Codemode workflow automation script files should use /workspace/automations/scripts/*.workflow.cm.js and bindings.json entries must set script.engine to "codemode-workflow".
- Bash automation script files usually use *.sh and bindings.json entries must set script.engine to "bash".
- Codemode automation scripts read event data from /context/event.json with state.readFile and should return JSON-serializable values.
- Do not call non-existent aliases like state.listFiles, state.readDirectory, or state.list.

${STATE_HARNESS_PROMPT}`;

export const DEFAULT_PI_HARNESSES: PiHarnessConfig[] = [
  {
    id: "bash",
    label: "Bash",
    description: "Built-in harness with bash access and the combined session filesystem.",
    systemPrompt: BASH_HARNESS_PROMPT,
    tools: ["bash"],
  },
  {
    id: "codemode",
    label: "Codemode",
    description: "Built-in harness with execCodeMode access to the combined session filesystem.",
    systemPrompt: CODEMODE_HARNESS_PROMPT,
    tools: ["execCodeMode"],
  },
];

export const DEFAULT_PI_HARNESS: PiHarnessConfig = DEFAULT_PI_HARNESSES[0] as PiHarnessConfig;

export const resolvePiHarnesses = (harnesses?: PiHarnessConfig[] | null): PiHarnessConfig[] => {
  if (Array.isArray(harnesses) && harnesses.length > 0) {
    return harnesses;
  }
  return DEFAULT_PI_HARNESSES;
};

export const createPiAgentName = (options: {
  harnessId: string;
  provider: PiModelProvider;
  model: string;
}) => `${options.harnessId}::${options.provider}::${options.model}`;

export const parsePiAgentName = (agent: string) => {
  const parts = agent.split("::");
  if (parts.length < 3) {
    return null;
  }
  const [harnessId, providerRaw, ...modelParts] = parts;
  const provider = providerRaw as PiModelProvider;
  if (!harnessId || !modelParts.length || !(provider in PI_PROVIDER_LABELS)) {
    return null;
  }
  return {
    harnessId,
    provider,
    model: modelParts.join("::"),
  };
};

export const findPiModelOption = (provider: PiModelProvider, name: string) => {
  return PI_MODEL_CATALOG.find((option) => option.provider === provider && option.name === name);
};
