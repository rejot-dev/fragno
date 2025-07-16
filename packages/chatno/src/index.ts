import {
  createLibrary,
  createLibraryClient,
  type FragnoPublicClientConfig,
} from "@rejot-dev/fragno";
import { addRoute } from "@rejot-dev/fragno/api";
import { wrapRouteQuery } from "@rejot-dev/fragno/client";
import { z } from "zod";

const libraryConfig = {
  name: "chatno",
  routes: [
    addRoute({
      method: "GET",
      path: "/",
      handler: async () => {
        return new Response(`Hello, world!`);
      },
    }),

    addRoute({
      method: "GET",
      path: "/thing/:message",
      handler: async ({ req, pathParams }) => {
        const message = pathParams.message;

        return Response.json({
          message,
          query: Object.fromEntries(new URL(req.url).searchParams),
        });
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

        return new Response(`Hello, world! ${number}`);
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
        return Response.json({
          apiProvider: "openai",
          model: "gpt-4o",
          systemPrompt: "You are a helpful assistant.",
        });
      },
    }),
  ],
} as const;

export interface ChatnoConfig {
  apiProvider?: "openai" | "anthropic";
}

export function createChatno() {
  return createLibrary(libraryConfig);
}

export function createChatnoClient(publicConfig: ChatnoConfig & FragnoPublicClientConfig = {}) {
  return createLibraryClient(publicConfig, libraryConfig, {
    hooks: {
      useAiConfig: wrapRouteQuery(libraryConfig.routes[1]),
    },
  } as const);
}
