/* eslint-disable @typescript-eslint/no-explicit-any */

import type { FragnoPublicClientConfig, FragnoPublicConfig } from "@fragno-dev/core";
import { OpenAI } from "openai";

// These types are just place holders, not to be copied
declare const ChatStreamRequestSchema: any;
declare const ResponseEventSchema: any;
declare const z: any;

// Function names should be like this, but (generic) arguments are wrong here.
declare function defineRoute<_T>(obj: any): any;
declare function defineRoutes<T, D>(fn: (args: { config: T; deps: D; services: any }) => any): any;

declare function defineLibrary<_T>(obj: any): any;

declare function createLibrary<_T>(obj: any, config: _T, fragnoConfig: any): any;
declare function createClientBuilder<_T>(obj: any, fragnoConfig: any): any;

// Example of a store that could be defined as part of the services object
class MessageStore {
  save(event: any) {
    console.log("save", event);
  }
}

// START_FILE: routes/chat.ts

type ChatRouteConfig = {
  model: "gpt-4-mini" | "gpt-3.5-turbo";
  systemPrompt: string;
};

type ChatRouteDeps = {
  openaiClient: OpenAI;
};

// The config and deps are route specific, they are usually a subset of the total config object
// passed to the library definition
const chatRouteFactory = defineRoutes<ChatRouteConfig, ChatRouteDeps>(
  ({ config, deps, services }) => {
    const { openaiClient } = deps;
    const { model, systemPrompt } = config;
    const { messageStore } = services;

    return [
      defineRoute({
        method: "POST",
        path: "/chat/stream",
        inputSchema: ChatStreamRequestSchema,
        outputSchema: z.array(ResponseEventSchema),
        handler: async ({ input }: any, { jsonStream }: any) => {
          const { messages } = await input.valid();

          const eventStream = await openaiClient.responses.create({
            model,
            input: [
              {
                role: "system",
                content: systemPrompt,
              },
              ...messages,
            ],
            stream: true,
          });

          return jsonStream(async (stream: any) => {
            for await (const event of eventStream) {
              messageStore.save(event);

              await stream.write(event);
            }
          });
        },
      }),
    ];
  },
);

// START_FILE: index.ts

// This is the full config required by the library
export interface ChatnoConfig {
  openaiApiKey: string;
  model: "gpt-4-mini" | "gpt-3.5-turbo";
  systemPrompt: string;
}

declare const config: ChatnoConfig;

// Normally we'd import from the route definition
// import { chatRouteFactory } from "./routes/chat.ts";

// defineLibrary creates a builder pattern style class/object
const chatnoDefinition = defineLibrary({
  name: "chatno",
  routes: [chatRouteFactory],
  // defineLibrary is generic over config, it can be given as first generic parameter, or inferred
  // by this object.
  config,
})
  // Dependencies are private to the library/fragment
  .withDependencies((config: ChatnoConfig) => {
    return {
      openaiClient: new OpenAI({ apiKey: config.openaiApiKey }),
    };
  })
  // Services can be called by users of the library as well
  .withServices((_config: ChatnoConfig, _dependencies: any) => {
    // Since dependencies are passed as an argument, we could decide to expose them here.
    return {
      messageStore: new MessageStore(),
    };
  });

export function createChatno(config: ChatnoConfig, fragnoConfig: FragnoPublicConfig = {}) {
  return createLibrary(chatnoDefinition, config, fragnoConfig);
}

export function createChatnoClient(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(chatnoDefinition, fragnoConfig);

  const useChat = b.createMutator("POST", "/chat/stream");

  return {
    useChat,
  };
}
