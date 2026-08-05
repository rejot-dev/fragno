import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { STATIC_FILE_CONTENT } from "@/files";

export const BACKOFFICE_PI_WORKFLOW_NAME = "interactive-chat-workflow";

export type PiSteeringMode = "all" | "one-at-a-time";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type PiModelProvider = "openai" | "anthropic" | "gemini";

export type PiModel = {
  provider: PiModelProvider;
  name: string;
};

export type PiModelOption = PiModel & {
  label: string;
};

export type StoredPiConfig = {
  scope: BackofficeContextScope;
};

export type PiRuntimeState = {
  configured: boolean;
  modelCatalog: PiModelOption[];
};

export type PiApiKeys = {
  openai?: string;
  anthropic?: string;
  gemini?: string;
};

export const PI_PROVIDER_TO_MODEL_PROVIDER = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
} as const satisfies Record<PiModelProvider, string>;

const PI_PROVIDER_THINKING_LEVELS: Partial<Record<PiModelProvider, PiThinkingLevel>> = {
  openai: "medium",
};

export const resolvePiModelThinkingLevel = (
  provider: PiModelProvider,
): PiThinkingLevel | undefined => PI_PROVIDER_THINKING_LEVELS[provider];

export const PI_SUPPORTED_MODELS: PiModelOption[] = [
  { provider: "openai", name: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { provider: "openai", name: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { provider: "openai", name: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
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

export const PI_TOOL_IDS = ["execCodeMode", "read"] as const;
export type PiToolId = (typeof PI_TOOL_IDS)[number];
export const PI_SYSTEM_PROMPT = STATIC_FILE_CONTENT["SYSTEM.md"];
export const PI_THINKING_LEVEL: PiThinkingLevel = "low";

export const piSessionModel = (
  metadata: Record<string, unknown> | null | undefined,
): PiModel | null => {
  const model = metadata?.model;
  if (!model || typeof model !== "object") {
    return null;
  }
  const { provider, name } = model as Record<string, unknown>;
  if (
    (provider !== "openai" && provider !== "anthropic" && provider !== "gemini") ||
    typeof name !== "string" ||
    !name
  ) {
    return null;
  }
  return { provider, name };
};

export const findPiModelOption = (provider: PiModelProvider, name: string) => {
  return PI_SUPPORTED_MODELS.find((option) => option.provider === provider && option.name === name);
};
