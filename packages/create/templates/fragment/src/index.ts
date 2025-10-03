import {
  defineFragment,
  defineRoute,
  defineRoutes,
  createFragment,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import { z } from "zod";

export interface ExampleFragmentServerConfig {
  initialData?: string;
}

type ExampleRouteConfig = {
  initialData: string;
};

type ExampleRouteDeps = {
  serverSideData: { value: string };
};

const exampleRoutesFactory = defineRoutes<ExampleRouteConfig, ExampleRouteDeps>().create(
  ({ deps }) => {
    const { serverSideData } = deps;

    return [
      defineRoute({
        method: "GET",
        path: "/hello",
        outputSchema: z.string(),
        handler: async (_, { json }) => {
          return json(serverSideData.value);
        },
      }),

      defineRoute({
        method: "POST",
        path: "/hello",
        inputSchema: z.object({ message: z.string() }),
        outputSchema: z.string(),
        errorCodes: [],
        handler: async ({ input }, { json }) => {
          const { message } = await input.valid();
          serverSideData.value = message;
          return json(message);
        },
      }),
    ];
  },
);

const exampleFragmentDefinition = defineFragment<ExampleFragmentServerConfig>("example-fragment")
  .withDependencies((config: ExampleFragmentServerConfig) => {
    return {
      serverSideData: { value: config.initialData ?? "Hello World! This is a server-side data." },
    };
  })
  .withServices((_cfg, deps) => {
    return {
      getData: () => deps.serverSideData.value,
    };
  });

export function createExampleFragment(
  serverConfig: ExampleFragmentServerConfig = {},
  fragnoConfig: FragnoPublicConfig = {},
) {
  const config: ExampleRouteConfig = {
    initialData: serverConfig.initialData ?? "Hello World! This is a server-side data.",
  };

  return createFragment(
    exampleFragmentDefinition,
    { ...serverConfig, ...config },
    [exampleRoutesFactory],
    fragnoConfig,
  );
}

export function createExampleFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(exampleFragmentDefinition, fragnoConfig, [exampleRoutesFactory]);

  return {
    useHello: b.createHook("/hello"),
    useHelloMutator: b.createMutator("POST", "/hello"),
  };
}
export type { FragnoRouteConfig } from "@fragno-dev/core/api";
