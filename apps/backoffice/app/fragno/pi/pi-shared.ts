import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { SYSTEM_FILE_CONTENT } from "@/files";

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
  scope: Extract<BackofficeContextScope, { kind: "org" }>;
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

const PI_PROVIDER_LABELS: Record<PiModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

export const PI_PROVIDER_TO_MODEL_PROVIDER = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
} as const satisfies Record<PiModelProvider, string>;

export const PI_MODEL_CATALOG: PiModelOption[] = [
  { provider: "openai", name: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { provider: "openai", name: "gpt-5.5", label: "GPT-5.5" },
  {
    provider: "anthropic",
    name: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
  },
  {
    provider: "anthropic",
    name: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
  },
  { provider: "anthropic", name: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { provider: "gemini", name: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  {
    provider: "gemini",
    name: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (Preview)",
  },
];

export const PI_TOOL_IDS = ["bash", "execCodeMode", "read"] as const;
export type PiToolId = (typeof PI_TOOL_IDS)[number];

export const DEFAULT_PI_HARNESSES: PiHarnessConfig[] = [
  {
    id: "default",
    label: "Default",
    description:
      "Built-in harness with codemode, read, and bash access to the combined session filesystem.",
    systemPrompt: SYSTEM_FILE_CONTENT["SYSTEM.md"],
    tools: ["execCodeMode", "read", "bash"],
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
