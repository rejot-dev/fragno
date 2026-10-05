import { STATIC_FILE_CONTENT } from "@/files/content/static";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Models intentionally offered by Backoffice, in default-selection order. */
export const PI_SUPPORTED_MODELS = [
  { provider: "openai", modelId: "gpt-6-luna", label: "GPT-6 Luna" },
  { provider: "openai", modelId: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { provider: "anthropic", modelId: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { provider: "google", modelId: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
] as const;

export const PI_SYSTEM_PROMPT = STATIC_FILE_CONTENT["SYSTEM.md"];
export const PI_THINKING_LEVEL: PiThinkingLevel = "low";
