import {
  createLibrary,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@rejot-dev/fragno";
import { addRoute } from "@rejot-dev/fragno/api";
import { createClientBuilder } from "@rejot-dev/fragno/client";
import { z } from "zod";

const serverSideData = "Hello World! This is a server-side data.";

const libraryConfig = {
  name: "example-fragment",
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
      path: "/data",
      outputSchema: z.string(),
      handler: async () => {
        return serverSideData;
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
  };

  return client;
}
