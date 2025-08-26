import {
  createLibrary,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@rejot-dev/fragno";
import { addRoute } from "@rejot-dev/fragno/api";
import { createClientBuilder } from "@rejot-dev/fragno/client";
import { z } from "zod";

let serverSideData = "Hello World! This is a server-side data.";

const services = {
  setData: async (data: string) => {
    serverSideData = data;
  },
  getData: () => {
    return serverSideData;
  },
} as const;

const libraryConfig = {
  name: "example-fragment",
  routes: [
    addRoute({
      method: "GET",
      path: "/hello", // TODO: Enforce "/" is not allowed as a path
      outputSchema: z.string(),
      handler: async (_, { json }) => {
        return json(`Hello, world!`);
      },
    }),

    addRoute({
      method: "GET",
      path: "/data",
      outputSchema: z.string(),
      handler: async ({ searchParams }, { json, error }) => {
        if (searchParams.get("error")) {
          return error(
            {
              message: "An error was triggered",
              code: "TEST_ERROR",
            },
            400,
          );
        }

        return json(services.getData());
      },
    }),

    addRoute({
      method: "POST",
      path: "/sample",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.string(),
      errorCodes: ["MESSAGE_CANNOT_BE_DIGITS_ONLY"],
      handler: async ({ input }, { json, error }) => {
        const { message } = await input.valid();

        await services.setData(message);

        if (/^\d+$/.test(message)) {
          return error(
            {
              message: "Message cannot be digits only",
              code: "MESSAGE_CANNOT_BE_DIGITS_ONLY",
            },
            400,
          );
        }

        return json(message);
      },
    }),
  ],
} as const;

export function createExampleFragment(publicConfig: FragnoPublicConfig = {}) {
  return createLibrary(publicConfig, libraryConfig, services);
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
