declare module "@mariozechner/pi-ai" {
  export type Api = string;
  export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

  export interface ThinkingBudgets {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
  }

  export interface SimpleStreamOptions {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    apiKey?: string;
    sessionId?: string;
    reasoning?: ThinkingLevel;
    thinkingBudgets?: ThinkingBudgets;
  }

  export interface TextContent {
    type: "text";
    text: string;
  }

  export interface ThinkingContent {
    type: "thinking";
    thinking: string;
  }

  export interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }

  export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  }

  export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

  export interface UserMessage {
    role: "user";
    content: string | TextContent[];
    timestamp: number;
  }

  export interface AssistantMessage {
    role: "assistant";
    content: Array<TextContent | ThinkingContent | ToolCall>;
    api: Api;
    provider: string;
    model: string;
    usage: Usage;
    stopReason: StopReason;
    errorMessage?: string;
    timestamp: number;
  }

  export interface ToolResultMessage {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: TextContent[];
    details?: unknown;
    isError: boolean;
    timestamp: number;
  }

  export type Message = UserMessage | AssistantMessage | ToolResultMessage;

  export interface Context {
    systemPrompt?: string;
    messages: Message[];
  }

  export interface Model<TApi extends Api> {
    id: string;
    name: string;
    api: TApi;
    provider: string;
    baseUrl: string;
    reasoning: boolean;
    input: Array<"text" | "image">;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
  }

  export type AssistantMessageEvent =
    | { type: "text_delta"; delta: string }
    | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage }
    | { type: "start"; [key: string]: unknown }
    | { type: "done"; [key: string]: unknown }
    | { type: "text_start"; [key: string]: unknown }
    | { type: "text_end"; [key: string]: unknown }
    | { type: "thinking_start"; [key: string]: unknown }
    | { type: "thinking_delta"; [key: string]: unknown }
    | { type: "thinking_end"; [key: string]: unknown }
    | { type: "toolcall_start"; [key: string]: unknown }
    | { type: "toolcall_delta"; [key: string]: unknown }
    | { type: "toolcall_end"; [key: string]: unknown };

  export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
    result(): Promise<AssistantMessage>;
  }

  export function getModel(provider: string, modelId: string): Model<Api>;
  export function getEnvApiKey(provider: string): string | undefined;
  export function completeSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessage>;
  export function streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
}
