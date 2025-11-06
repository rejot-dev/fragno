import {
  defineFragment,
  defineRoute,
  createFragment,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
  defineRoutes,
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

const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant integrated into a dashboard.`;

interface SimpleStreamService {
  generateStreamMessages: () => AsyncGenerator<{ message: string }>;
}

export const chatnoDefinition = defineFragment<ChatnoServerConfig>("chatno")
  .withDependencies(({ config }) => {
    return {
      openaiClient: new OpenAI({
        apiKey: config.openaiApiKey,
      }),
    };
  })
  .providesService(({ deps, defineService }) => {
    return defineService({
      getOpenAIURL: () => deps.openaiClient.baseURL,
      generateStreamMessages: async function* () {
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          yield { message: `Item ${i + 1}` };
        }
      },
    });
  });

const simpleStreamRoute = defineRoutes<ChatnoServerConfig, {}, SimpleStreamService>().create(
  ({ services }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/simple-stream",
        outputSchema: z.array(
          z.object({
            message: z.string(),
          }),
        ),
        handler: async (_ctx, { jsonStream }) => {
          return jsonStream(async (stream) => {
            for await (const item of services.generateStreamMessages()) {
              await stream.write(item);
            }
          });
        },
      }),
    ];
  },
);

export { healthRoute, simpleStreamRoute };
export const routes = [chatRouteFactory, healthRoute, simpleStreamRoute] as const;

// Server-side factory
export function createChatno(
  chatnoConfig: ChatnoServerConfig,
  fragnoConfig: FragnoPublicConfig = {},
) {
  const config = {
    model: chatnoConfig.model ?? "gpt-5-nano",
    systemPrompt: chatnoConfig.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  };

  return createFragment(chatnoDefinition, { ...chatnoConfig, ...config }, routes, fragnoConfig);
}

// Generic client-side factory
export function createChatnoClients(fragnoConfig: FragnoPublicClientConfig) {
  const cb = createClientBuilder(chatnoDefinition, fragnoConfig, routes);

  const chatStream = cb.createMutator("POST", "/chat/stream");

  const aggregatedMessage = computed(chatStream.mutatorStore, ({ data }) => {
    return (data ?? [])
      .filter((item) => item.type === "response.output_text.delta")
      .map((item) => item.delta)
      .join("");
  });

  function sendMessage(message: string) {
    chatStream.mutatorStore.mutate({
      body: {
        messages: [{ type: "chat", id: crypto.randomUUID(), role: "user", content: message }],
      },
    });
  }

  return {
    useSendMessage: cb.createStore({
      response: aggregatedMessage,
      responseLoading: computed(chatStream.mutatorStore, ({ loading }) => loading),
      sendMessage,
    }),
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core/api";
