import {
  createLibrary,
  createLibraryClient,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@rejot-dev/fragno";
import { addRoute } from "@rejot-dev/fragno/api";
import { z } from "zod";

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
      handler: async ({ path, req, pathParams }) => {
        const message = pathParams.path;

        return {
          path,
          message,
          query: Object.fromEntries(new URL(req.url).searchParams),
        };
      },
    }),

    addRoute({
      method: "POST",
      path: "/echo",
      inputSchema: z.object({
        number: z.number(),
      }),
      outputSchema: z.string(),
      handler: async ({ input }) => {
        const { number } = await input.valid();
        return `Hello, world! ${number}`;
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
  return createLibraryClient(publicConfig, libraryConfig, (builder) => {
    return builder
      .addHook("useAiConfig", "/ai-config")
      .addHook("useHelloWorld", "/")
      .addHook("useThing", "/thing/**:path");
  });
}
