import {
  createLibrary,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@rejot-dev/fragno";
import { addRoute } from "@rejot-dev/fragno/api";
import { createClientBuilder } from "@rejot-dev/fragno/client";
import { z } from "zod";

let serverSideData = "Hello World! This is a server-side data.";

const libraryConfig = {
  name: "example-fragment",
  routes: [
    addRoute({
      method: "GET",
      path: "/hello", // TODO: Enforce "/" is not allowed as a path
      outputSchema: z.string(),
      handler: async () => {
        return `Hello, world!`;
      },
    }),

    addRoute({
      method: "GET",
      path: "/data",
      outputSchema: z.string(),
      handler: async () => {
        return serverSideData;
      },
    }),

    addRoute({
      method: "POST",
      path: "/sample",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.string(),
      handler: async ({ input }) => {
        const { message } = await input.valid();
        serverSideData = message;
        return message;
      },
    }),
  ],
} as const;

export function createExampleFragment(publicConfig: FragnoPublicConfig = {}) {
  return createLibrary(publicConfig, libraryConfig);
}

export function createExampleFragmentClient(publicConfig: FragnoPublicClientConfig = {}) {
  const b = createClientBuilder(publicConfig, libraryConfig);

  // Explicitly type the return value to ensure TypeScript uses these exact properties
  const client = {
    useData: b.createHook("/data"),
    useSampleMutator: b.createMutator("POST", "/sample"),
  };

  return client;
}
