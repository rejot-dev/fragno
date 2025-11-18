import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
import { type FragnoPublicClientConfig, type FragnoPublicConfig } from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import OpenAI from "openai";
import { z } from "zod";
import { defineRoutes } from "@fragno-dev/core/api/route";
import { instantiate } from "@fragno-dev/core/api/fragment-instantiator";
import { chatRouteFactory } from "./server/chatno-api";
import { computed } from "nanostores";

export interface ChatnoServerConfig {
  openaiApiKey: string;
  model?: "gpt-5-mini" | "4o-mini" | "gpt-5-nano";
  systemPrompt?: string;
}

export const chatnoDefinition = defineFragment<ChatnoServerConfig>("chatno")
  .withDependencies(({ config }) => {
    return {
      openaiClient: new OpenAI({
        apiKey: config.openaiApiKey,
      }),
    };
  })
  .providesBaseService(({ deps }) => {
    return {
      getOpenAIURL: () => deps.openaiClient.baseURL,
      generateStreamMessages: async function* () {
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          yield { message: `Item ${i + 1}` };
        }
      },
    };
  })
  .build();

const healthAndStreamRoutesFactory = defineRoutes(chatnoDefinition).create(
  ({ defineRoute, services }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/health",
        outputSchema: z.object({
          status: z.literal("ok"),
        }),
        handler: async (_ctx, { json }) => {
          return json({ status: "ok" });
        },
      }),
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

export const routes = [chatRouteFactory, healthAndStreamRoutesFactory] as const;

// Server-side factory
export function createChatno(
  chatnoConfig: ChatnoServerConfig,
  fragnoConfig: FragnoPublicConfig = {},
) {
  return instantiate(chatnoDefinition)
    .withConfig(chatnoConfig)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();
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
