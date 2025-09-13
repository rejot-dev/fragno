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
import { computed } from "nanostores";

export interface ChatnoServerConfig {
  openaiApiKey: string;
  model?: "gpt-5-mini" | "4o-mini" | "gpt-5-nano";
  systemPrompt?: string;
}

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

const simpleStreamRoute = defineRoute({
  method: "GET",
  path: "/simple-stream",
  outputSchema: z.array(
    z.object({
      message: z.string(),
    }),
  ),
  handler: async (_ctx, { jsonStream }) => {
    return jsonStream(async (stream) => {
      for (let i = 0; i < 10; i++) {
        await stream.sleep(500);
        await stream.write({ message: `Item ${i + 1}` });
      }
    });
  },
});

const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant integrated into a dashboard.`;

const chatnoDefinition = defineLibrary<ChatnoServerConfig>("chatno").withDependencies(
  (config: ChatnoServerConfig) => {
    return {
      openaiClient: new OpenAI({
        apiKey: config.openaiApiKey,
      }),
    };
  },
);

const routes = [chatRouteFactory, healthRoute, simpleStreamRoute] as const;

// Server-side factory
export function createChatno(
  chatnoConfig: ChatnoServerConfig,
  fragnoConfig: FragnoPublicConfig = {},
) {
  const config = {
    model: chatnoConfig.model ?? "gpt-5-nano",
    systemPrompt: chatnoConfig.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  };

  return createLibrary(chatnoDefinition, { ...chatnoConfig, ...config }, routes, fragnoConfig);
}

// Client-side factory
export function createChatnoClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const b = createClientBuilder(chatnoDefinition, fragnoConfig, routes);

  const useSimpleStream = b.createHook("/simple-stream");

  const currentMessage = computed(useSimpleStream.store({}), ({ data }) => {
    const msg = (data ?? []).map((item) => item.message).join(", ");
    return msg;
  });

  return {
    useChat: b.createMutator("POST", "/chat/stream"),
    useSimpleStream: useSimpleStream,
    useHealth: b.createHook("/health"),
    useCurrentMessage: b.createStore(currentMessage),
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core/api";
