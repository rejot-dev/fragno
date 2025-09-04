import {
  createLibrary,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@rejot-dev/fragno";
import { createClientBuilder } from "@rejot-dev/fragno/client";
import { addRoute } from "@rejot-dev/fragno/api";
import { z } from "zod";
import { fileMessageService } from "./file-message-service.server";

const api = {
  messages: fileMessageService,
};

export const chatnoLibraryConfig = {
  name: "chatno",
  routes: [
    addRoute({
      method: "GET",
      path: "/",
      outputSchema: z.string(),
      handler: async (_ctx, { json }) => {
        return json(`Hello, world!`);
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
      handler: async ({ path, searchParams, pathParams }, { json }) => {
        const message = pathParams.path;

        return json({
          path,
          message,
          query: Object.fromEntries(searchParams),
        });
      },
    }),

    addRoute({
      method: "GET",
      path: "/echo/:message",
      outputSchema: z.string(),
      errorCodes: ["MESSAGE_NOT_FOUND"],
      queryParameters: ["capital"],
      handler: async ({ pathParams, searchParams }, { json, error }) => {
        const messageKey = pathParams.message;
        const shouldCapitalize = searchParams.get("capital") === "true";

        const data = await api.messages.getData(messageKey);

        if (!data) {
          return error(
            {
              message: "Message not found",
              code: "MESSAGE_NOT_FOUND",
            },
            404,
          );
        }

        const text = shouldCapitalize ? data.toUpperCase() : data;

        return json(text);
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
      errorCodes: ["MESSAGE_CANNOT_BE_DIGITS_ONLY"],
      handler: async ({ pathParams, input }, { json, error }) => {
        const { message } = await input.valid();
        const messageKey = pathParams.messageKey;

        const previous = await api.messages.getData(messageKey);
        await api.messages.setData(messageKey, message);

        if (/^\d+$/.test(message)) {
          return error(
            {
              message: "Message cannot be digits only",
              code: "MESSAGE_CANNOT_BE_DIGITS_ONLY",
            },
            400,
          );
        }

        // console.log("PUT serverSideMessagesStores", serverSideMessagesStores);

        return json({
          previous,
          messageKey,
          message,
        });
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
      handler: async (_ctx, { json }) => {
        return json({
          apiProvider: "openai" as const,
          model: "gpt-4o",
          systemPrompt: "You are a helpful assistant.",
        });
      },
    }),

    addRoute({
      method: "GET",
      path: "/stream",
      outputSchema: z.array(z.object({ message: z.string() })),
      handler: async (_ctx, { jsonStream }) => {
        return jsonStream(async (stream) => {
          await stream.sleep(1000);
          await stream.write({ message: "Hello, " });
          await stream.sleep(1000);
          await stream.write({ message: "World!" });
        });
      },
    }),
  ],
} as const;

export function createChatno(publicConfig: FragnoPublicConfig = {}) {
  return createLibrary(publicConfig, chatnoLibraryConfig, api);
}

export interface ChatnoConfig {
  apiProvider?: "openai" | "anthropic";
}

export function createChatnoClient(publicConfig: ChatnoConfig & FragnoPublicClientConfig = {}) {
  const b = createClientBuilder(publicConfig, chatnoLibraryConfig);

  const client = {
    useAiConfig: b.createHook("/ai-config"),
    useThing: b.createHook("/thing/**:path"),
    useEcho: b.createHook("/echo/:message"),
    useEchoMutator: b.createMutator("PUT", "/echo/:messageKey", (invalidate, { pathParams }) => {
      invalidate("GET", "/echo/:message", { pathParams: { message: pathParams.messageKey } });
    }),
    useStream: b.createHook("/stream"),
  };

  return client;
}
