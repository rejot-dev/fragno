import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@mariozechner/pi-ai";
import type { AiFragmentConfig, AiModelRef } from "./index";
import { resolveOpenAIApiKey } from "./openai";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const buildAssistantMessage = (
  text: string,
  model: Model<Api>,
  timestamp: number,
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
  stopReason: "stop",
  timestamp,
});

const loadPiAi = async () => {
  try {
    return await import("@mariozechner/pi-ai");
  } catch {
    throw new Error("PI_AI_MISSING");
  }
};

export const resolvePiAiModel = async ({
  modelId,
  modelRef,
}: {
  modelId: string;
  modelRef: AiModelRef;
}) => {
  if (!modelRef.provider) {
    throw new Error("MODEL_PROVIDER_MISSING");
  }

  const { getModel } = await loadPiAi();
  const provider = modelRef.provider as unknown as Parameters<typeof getModel>[0];
  const model = modelId as unknown as Parameters<typeof getModel>[1];
  const base = getModel(provider, model) as Model<Api>;
  const baseUrl = modelRef.baseUrl ?? base.baseUrl;
  const headers = modelRef.headers
    ? { ...(base.headers ?? undefined), ...modelRef.headers }
    : base.headers;

  return {
    ...base,
    baseUrl,
    ...(headers ? { headers } : {}),
  } as Model<Api>;
};

export const buildPiAiContext = ({
  input,
  model,
}: {
  input: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  model: Model<Api>;
}): Context => {
  const systemMessages: string[] = [];
  const messages: Context["messages"] = [];
  let timestamp = Date.now();

  for (const entry of input) {
    if (entry.role === "system") {
      systemMessages.push(entry.content);
      continue;
    }

    if (entry.role === "user") {
      messages.push({ role: "user", content: entry.content, timestamp });
    } else if (entry.role === "assistant") {
      messages.push(buildAssistantMessage(entry.content, model, timestamp));
    }

    timestamp += 1;
  }

  return {
    systemPrompt: systemMessages.length ? systemMessages.join("\n\n") : undefined,
    messages,
  };
};

export const resolvePiAiResponseText = (message: AssistantMessage) => {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text || null;
};

export const resolvePiAiThinkingLevel = (
  thinkingLevel: string | null | undefined,
): ThinkingLevel | undefined => {
  if (!thinkingLevel || thinkingLevel === "off") {
    return undefined;
  }

  if (
    thinkingLevel === "minimal" ||
    thinkingLevel === "low" ||
    thinkingLevel === "medium" ||
    thinkingLevel === "high" ||
    thinkingLevel === "xhigh"
  ) {
    return thinkingLevel;
  }

  return undefined;
};

export const resolvePiAiApiKey = async ({
  config,
  provider,
}: {
  config: AiFragmentConfig;
  provider: string;
}) => {
  const resolved = await resolveOpenAIApiKey(config, provider);
  if (resolved) {
    return resolved;
  }

  const { getEnvApiKey } = await loadPiAi();
  return getEnvApiKey(provider);
};

export const buildPiAiStreamOptions = async ({
  config,
  provider,
  thinkingLevel,
  signal,
}: {
  config: AiFragmentConfig;
  provider: string;
  thinkingLevel: string | null | undefined;
  signal?: AbortSignal;
}) => {
  const apiKey = await resolvePiAiApiKey({ config, provider });
  const reasoning = resolvePiAiThinkingLevel(thinkingLevel);

  const options: SimpleStreamOptions = {
    apiKey,
    sessionId: config.sessionId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    thinkingBudgets: config.thinkingBudgets,
    ...(reasoning ? { reasoning } : {}),
    ...(signal ? { signal } : {}),
  };

  return { apiKey, options };
};

export const completeWithPiAi = async (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) => {
  const { completeSimple } = await loadPiAi();
  return completeSimple(model, context, options);
};

export const streamWithPiAi = async (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) => {
  const { streamSimple } = await loadPiAi();
  return streamSimple(model, context, options);
};
