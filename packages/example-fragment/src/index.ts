import {
  createLibrary,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@rejot-dev/fragno";
import { addRoute } from "@rejot-dev/fragno/api";
import { createClientBuilder } from "@rejot-dev/fragno/client";
import { z } from "zod";

import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { createHash } from "node:crypto";

let serverSideData = "Hello World! This is a server-side data.";

const api = {
  getHashFromHostsFileData: async () => {
    const hostsPath =
      platform() === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";

    try {
      const data = await readFile(hostsPath, { encoding: "utf8" });
      return createHash("sha256").update(data).digest("hex");
    } catch {
      return null;
    }
  },
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
      path: "/hash", // TODO: Enforce "/" is not allowed as a path
      outputSchema: z.string(),
      handler: async (_, { json }) => {
        const hash = await api.getHashFromHostsFileData();
        return json(hash ? `The hash of your 'hosts' file is: ${hash}` : "No hash found :(");
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

        return json(api.getData());
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

        await api.setData(message);

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
  return createLibrary(publicConfig, libraryConfig, api);
}

export function createExampleFragmentClient(publicConfig: FragnoPublicClientConfig = {}) {
  const b = createClientBuilder(publicConfig, libraryConfig);

  const client = {
    useHash: b.createHook("/hash"),
    useData: b.createHook("/data"),
    useSampleMutator: b.createMutator("POST", "/sample"),
  };

  return client;
}
