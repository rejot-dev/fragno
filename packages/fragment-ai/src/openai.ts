import OpenAI from "openai";

export const resolveMessageText = (message: { text: string | null; content: unknown }) => {
  if (message.text) {
    return message.text;
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  if (message.content && typeof message.content === "object" && "text" in message.content) {
    const text = (message.content as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }

  return null;
};

export const resolveOpenAIResponseId = (event: unknown) => {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as {
    type?: unknown;
    id?: unknown;
    response?: { id?: unknown };
    response_id?: unknown;
  };

  if (record.response && typeof record.response.id === "string") {
    return record.response.id;
  }

  if (typeof record.response_id === "string") {
    return record.response_id;
  }

  if (typeof record.type === "string" && record.type.startsWith("response.")) {
    if (typeof record.id === "string") {
      return record.id;
    }
  }

  return null;
};

export const resolveOpenAIResponseText = (response: unknown) => {
  if (!response || typeof response !== "object") {
    return null;
  }

  const record = response as {
    output_text?: unknown;
    output?: Array<{ type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>;
  };

  if (typeof record.output_text === "string") {
    return record.output_text;
  }

  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (!item || typeof item !== "object") {
        continue;
      }

      if (item.type !== "message" || !Array.isArray(item.content)) {
        continue;
      }

      const textPart = item.content.find((part) => part?.type === "output_text");
      if (textPart && typeof textPart.text === "string") {
        return textPart.text;
      }
    }
  }

  return null;
};

export const resolveOpenAIApiKey = async (config: {
  apiKey?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}) => {
  return (
    config.apiKey ??
    (typeof config.getApiKey === "function" ? await config.getApiKey("openai") : undefined)
  );
};

export const createOpenAIClient = async (config: {
  apiKey?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  baseUrl?: string;
  defaultModel?: { baseUrl?: string; headers?: Record<string, string> };
}) => {
  const apiKey = await resolveOpenAIApiKey(config);

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY_MISSING");
  }

  const baseURL = config.baseUrl ?? config.defaultModel?.baseUrl;
  const defaultHeaders = config.defaultModel?.headers;

  return new OpenAI({ apiKey, baseURL, defaultHeaders });
};

export const buildOpenAIIdempotencyKey = (runId: string, attempt: number) =>
  `ai-run:${runId}:attempt:${attempt}`;
