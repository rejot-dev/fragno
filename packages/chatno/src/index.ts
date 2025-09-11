import {
  defineLibrary,
  defineRoute,
  createLibrary,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@fragno-dev/core";
import OpenAI from "openai";
import { z } from "zod";
import { createClientBuilder } from "@fragno-dev/core/client";
import { chatRouteFactory } from "./server/chatno-api";

export interface ChatnoServerConfig {
  openaiApiKey: string;
  model?: "gpt-5-mini" | "4o-mini";
  systemPrompt?: string;
}

type ChatRouteConfig = {
  model: "gpt-5-mini" | "4o-mini";
  systemPrompt: string;
};

const healthRoute = defineRoute({
  method: "GET",
  path: "/health",
  outputSchema: z.object({
    status: z.literal("ok"),
  }),
  handler: async (_ctx, { json }) => {
    return json({ status: "ok" });
  },
});

const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant integrated into a dashboard.`;

// Library definition with builder pattern
const chatnoDefinition = defineLibrary<ChatnoServerConfig>("chatno").withDependencies(
  (config: ChatnoServerConfig) => {
    return {
      openaiClient: new OpenAI({
        apiKey: config.openaiApiKey,
      }),
    };
  },
);

// Server-side factory
export function createChatno(
  chatnoConfig: ChatnoServerConfig,
  fragnoConfig: FragnoPublicConfig = {},
) {
  const config: ChatRouteConfig = {
    model: chatnoConfig.model ?? "gpt-5-mini",
    systemPrompt: chatnoConfig.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  };

  return createLibrary(
    chatnoDefinition,
    { ...chatnoConfig, ...config },
    [chatRouteFactory, healthRoute],
    fragnoConfig,
  );
}

// Client-side factory
export function createChatnoClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const b = createClientBuilder(chatnoDefinition, fragnoConfig, [chatRouteFactory, healthRoute]);

  const useChat = b.createMutator("POST", "/chat/stream");

  return {
    useChat,
    useHealth: b.createHook("/health"),
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core/api";
