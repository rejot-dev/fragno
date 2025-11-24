import {
  defineFragment,
  defineRoutes,
  instantiate,
  type FragnoPublicConfig,
} from "@fragno-dev/core";
import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

// NOTE: We use zod here for defining schemas, but any StandardSchema library can be used!
//       For a complete list see:
// https://github.com/standard-schema/standard-schema#what-schema-libraries-implement-the-spec
import { z } from "zod";

export interface ExampleConfig {
  initialData?: string;
}

const exampleFragmentDefinition = defineFragment<ExampleConfig>("example-fragment")
  .withDependencies(({ config }) => {
    return {
      serverSideData: { value: config.initialData ?? "Hello World! This is a server-side data." },
    };
  })
  .providesBaseService(({ deps }) => {
    return {
      getData: () => deps.serverSideData.value,
    };
  })
  .build();

const exampleRoutesFactory = defineRoutes(exampleFragmentDefinition).create(
  ({ deps, defineRoute }) => {
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

export function createExampleFragment(
  config: ExampleConfig = {},
  options: FragnoPublicConfig = {},
) {
  return instantiate(exampleFragmentDefinition)
    .withConfig(config)
    .withRoutes([exampleRoutesFactory])
    .withOptions(options)
    .build();
}

export function createExampleFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(exampleFragmentDefinition, fragnoConfig, [exampleRoutesFactory]);

  return {
    useHello: b.createHook("/hello"),
    useHelloMutator: b.createMutator("POST", "/hello"),
  };
}
export type { FragnoRouteConfig } from "@fragno-dev/core";
