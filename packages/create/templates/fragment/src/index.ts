import {
  defineFragment,
  defineRoute,
  defineRoutes,
  createFragment,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";

// NOTE: We use zod here for defining schemas, but any StandardSchema library can be used!
//       For a complete list see:
// https://github.com/standard-schema/standard-schema#what-schema-libraries-implement-the-spec
import { z } from "zod";

export interface ExampleConfig {
  initialData?: string;
}

type ExampleServices = {
  getData: () => string;
};

type ExampleDeps = {
  serverSideData: { value: string };
};

const exampleRoutesFactory = defineRoutes<ExampleConfig, ExampleDeps, ExampleServices>().create(
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

const exampleFragmentDefinition = defineFragment<ExampleConfig>("example-fragment")
  .withDependencies(({ config }) => {
    return {
      serverSideData: { value: config.initialData ?? "Hello World! This is a server-side data." },
    };
  })
  .withServices(({ deps }) => {
    return {
      getData: () => deps.serverSideData.value,
    };
  });

export function createExampleFragment(
  config: ExampleConfig = {},
  fragnoConfig: FragnoPublicConfig = {},
) {
  return createFragment(exampleFragmentDefinition, config, [exampleRoutesFactory], fragnoConfig);
}

export function createExampleFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(exampleFragmentDefinition, fragnoConfig, [exampleRoutesFactory]);

  return {
    useHello: b.createHook("/hello"),
    useHelloMutator: b.createMutator("POST", "/hello"),
  };
}
export type { FragnoRouteConfig } from "@fragno-dev/core/api";
