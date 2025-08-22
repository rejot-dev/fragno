import {
  createLibrary,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@rejot-dev/fragno";
import { addRoute } from "@rejot-dev/fragno/api";
import { createClientBuilder } from "@rejot-dev/fragno/client";
import { z } from "zod";

const serverSideMessagesStores: Record<string, string> = {};

const libraryConfig = {
  name: "chatno",
  routes: [
    addRoute({
      method: "GET",
      path: "/",
      outputSchema: z.string(),
      handler: async () => {
        return `Hello, world!`;
      },
    }),

    addRoute({
      method: "GET",
      path: "/thing/**:path",
      outputSchema: z.object({
        path: z.string(),
        message: z.string(),
        query: z.record(z.string(), z.string()),
      }),
      handler: async ({ path, searchParams, pathParams }) => {
        const message = pathParams.path;

        return {
          path,
          message,
          query: Object.fromEntries(searchParams),
        };
      },
    }),

    addRoute({
      method: "GET",
      path: "/echo/:message",
      outputSchema: z.string(),
      handler: async ({ pathParams, searchParams }) => {
        const messageKey = pathParams.message;
        const shouldCapitalize = searchParams.get("capital") === "true";

        console.log("serverSideMessagesStores", serverSideMessagesStores);

        if (!(messageKey in serverSideMessagesStores)) {
          return shouldCapitalize ? `(message not found)`.toUpperCase() : `(message not found)`;
        }

        return shouldCapitalize
          ? serverSideMessagesStores[messageKey].toUpperCase()
          : serverSideMessagesStores[messageKey];
      },
    }),

    addRoute({
      method: "PUT",
      path: "/echo/:messageKey",
      inputSchema: z.object({
        message: z.string(),
      }),
      outputSchema: z.object({
        messageKey: z.string(),
        previous: z.string().optional(),
        message: z.string(),
      }),
      handler: async ({ pathParams, input }) => {
        const { message } = await input.valid();
        const messageKey = pathParams.messageKey;

        const previous = serverSideMessagesStores[messageKey];
        serverSideMessagesStores[messageKey] = message;

        console.log("PUT serverSideMessagesStores", serverSideMessagesStores);

        return {
          previous,
          messageKey,
          message,
        };
      },
    }),

    addRoute({
      method: "GET",
      path: "/ai-config",
      outputSchema: z.object({
        apiProvider: z.enum(["openai", "anthropic"]),
        model: z.string(),
        systemPrompt: z.string(),
      }),
      handler: async () => {
        return {
          apiProvider: "openai" as const,
          model: "gpt-4o",
          systemPrompt: "You are a helpful assistant.",
        };
      },
    }),
  ],
} as const;

export interface ChatnoConfig {
  apiProvider?: "openai" | "anthropic";
}

export function createChatno(publicConfig: FragnoPublicConfig = {}) {
  return createLibrary(publicConfig, libraryConfig);
}

export function createChatnoClient(publicConfig: ChatnoConfig & FragnoPublicClientConfig = {}) {
  const b = createClientBuilder(publicConfig, libraryConfig);

  const client = {
    useAiConfig: b.createHook("/ai-config"),
    useThing: b.createHook("/thing/**:path"),
    useEcho: b.createHook("/echo/:message"),
    useEchoMutator: b.createMutator("PUT", "/echo/:messageKey"),
  };

  return client;
}
