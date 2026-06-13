import { BASH_HARNESS_REFERENCE, SYSTEM_FILE_CONTENT, SYSTEM_GUIDANCE } from "@/files";

import { createCodemodeSystemPrompt } from "../codemode/state-prompt";
import { runtimeToolFamilies } from "../runtime-tools/tool-families";

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
  { provider: "openai", name: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { provider: "openai", name: "gpt-5.5", label: "GPT-5.5" },
  { provider: "anthropic", name: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { provider: "anthropic", name: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { provider: "anthropic", name: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { provider: "gemini", name: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { provider: "gemini", name: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
];

export const PI_TOOL_IDS = ["bash", "execCodeMode", "read"] as const;
export type PiToolId = (typeof PI_TOOL_IDS)[number];

const SKILL_READING_PROMPT =
  "When available_skills lists a matching skill, use the read tool to open " +
  "the corresponding /system/skills/<skill-name>/SKILL.md or /workspace/skills/<skill-name>/SKILL.md file before proceeding.";

const BASH_HARNESS_PROMPT = `SYSTEM.md (agent guidance):\n\n${DEFAULT_SYSTEM_PROMPT}\n\n${SKILL_READING_PROMPT}\n\n${BASH_HARNESS_REFERENCE}`;

const STATE_HARNESS_PROMPT = createCodemodeSystemPrompt({
  families: runtimeToolFamilies,
});

const CODEMODE_HARNESS_PROMPT = `SYSTEM.md (agent guidance):\n\n${DEFAULT_SYSTEM_PROMPT}

Codemode harness guidance:

${SKILL_READING_PROMPT}

- Use execCodeMode for coordinated filesystem work in the combined session filesystem.
- Use state.* APIs from inside execCodeMode for multi-file operations.
- Prefer camelCase domain tools when they are available in codemode contexts.
- Do not assume import() or module loading is available inside dynamic Worker code.
- Write codemode as either a standalone async arrow function, for example: async () => { return await state.readFile("/workspace/file.txt"); }, or a workflow definition: defineWorkflow({ name: "my-workflow" }, async (event, step) => { ... }).
- Use defineWorkflow(...) when work should run durably with workflow steps, retries, sleeps, or event waits.
- Codemode automation script files must use /workspace/automations/*.cm.js.
- Bash automation script files usually use /workspace/automations/*.sh.
- Codemode automation scripts read event data from /context/event.json with state.readFile and should return JSON-serializable values.
- Do not call non-existent aliases like state.listFiles, state.readDirectory, or state.list.

${STATE_HARNESS_PROMPT}`;

export const DEFAULT_PI_HARNESSES: PiHarnessConfig[] = [
  {
    id: "codemode",
    label: "Codemode",
    description: "Built-in harness with execCodeMode access to the combined session filesystem.",
    systemPrompt: CODEMODE_HARNESS_PROMPT,
    tools: ["execCodeMode", "read"],
  },
  {
    id: "bash",
    label: "Bash",
    description: "Built-in harness with bash access and the combined session filesystem.",
    systemPrompt: BASH_HARNESS_PROMPT,
    tools: ["bash", "read"],
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
