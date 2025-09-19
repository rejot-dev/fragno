import {
  defineLibrary,
  defineRoute,
  defineRoutes,
  createLibrary,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import { z } from "zod";

import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { createHash } from "node:crypto";

export interface ExampleFragmentServerConfig {
  initialData?: string;
}

type ExampleRouteConfig = {
  initialData: string;
};

type ExampleRouteDeps = {
  serverSideData: { value: string };
};

const getHashFromHostsFileData = async () => {
  const hostsPath =
    platform() === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";

  try {
    const data = await readFile(hostsPath, { encoding: "utf8" });
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
};

const exampleRoutesFactory = defineRoutes<ExampleRouteConfig, ExampleRouteDeps>().create(
  ({ deps }) => {
    const { serverSideData } = deps;

    return [
      defineRoute({
        method: "GET",
        path: "/hash",
        outputSchema: z.string(),
        handler: async (_, { json }) => {
          const hash = await getHashFromHostsFileData();
          return json(hash ? `The hash of your 'hosts' file is: ${hash}` : "No hash found :(");
        },
      }),

      defineRoute({
        method: "GET",
        path: "/data",
        outputSchema: z.string(),
        queryParameters: ["error"],
        handler: async ({ query }, { json, error }) => {
          if (query.get("error")) {
            return error(
              {
                message: "An error was triggered",
                code: "TEST_ERROR",
              },
              400,
            );
          }
          return json(serverSideData.value);
        },
      }),

      defineRoute({
        method: "POST",
        path: "/sample",
        inputSchema: z.object({ message: z.string() }),
        outputSchema: z.string(),
        errorCodes: ["MESSAGE_CANNOT_BE_DIGITS_ONLY"],
        handler: async ({ input }, { json, error }) => {
          const { message } = await input.valid();

          if (/^\d+$/.test(message)) {
            return error(
              {
                message: "Message cannot be digits only",
                code: "MESSAGE_CANNOT_BE_DIGITS_ONLY",
              },
              400,
            );
          }
          serverSideData.value = message;

          return json(message);
        },
      }),
    ];
  },
);

const exampleFragmentDefinition = defineLibrary<ExampleFragmentServerConfig>("example-fragment")
  .withDependencies((config: ExampleFragmentServerConfig) => {
    return {
      serverSideData: { value: config.initialData ?? "Hello World! This is a server-side data." },
    };
  })
  .withServices((_cfg, deps) => {
    return {
      getData: () => deps.serverSideData.value,
      getHashFromHostsFileData,
    };
  });

export function createExampleFragment(
  serverConfig: ExampleFragmentServerConfig = {},
  fragnoConfig: FragnoPublicConfig = {},
) {
  const config: ExampleRouteConfig = {
    initialData: serverConfig.initialData ?? "Hello World! This is a server-side data.",
  };

  return createLibrary(
    exampleFragmentDefinition,
    { ...serverConfig, ...config },
    [exampleRoutesFactory],
    fragnoConfig,
  );
}

export function createExampleFragmentClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const b = createClientBuilder(exampleFragmentDefinition, fragnoConfig, [exampleRoutesFactory]);

  return {
    useHash: b.createHook("/hash"),
    useData: b.createHook("/data"),
    useSampleMutator: b.createMutator("POST", "/sample"),
  };
}
export type { FragnoRouteConfig } from "@fragno-dev/core/api";
