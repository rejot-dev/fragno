import { define } from "gunshi";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defineFragment,
  instantiate,
  type AnyFragnoInstantiatedFragment,
  type AnyRouteOrFactory,
} from "@fragno-dev/core";
import { toNodeHandler } from "@fragno-dev/node";
import { InMemoryAdapter, withDatabase, type SyncCommandRegistry } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";

type ServerDefinitionConfig = {
  fragmentName: string;
  schema: AnySchema;
  syncCommands: SyncCommandRegistry;
  routes?: AnyRouteOrFactory[];
};

type ServerModule = {
  default?: unknown;
  fragment?: AnyFragnoInstantiatedFragment;
  createFragment?: (options: {
    databaseAdapter: InMemoryAdapter;
    outbox: { enabled: boolean };
  }) => AnyFragnoInstantiatedFragment | Promise<AnyFragnoInstantiatedFragment>;
  server?: ServerDefinitionConfig;
};

const isDefinitionConfig = (value: unknown): value is ServerDefinitionConfig =>
  Boolean(
    value &&
      typeof value === "object" &&
      "fragmentName" in value &&
      "schema" in value &&
      "syncCommands" in value,
  );

const isFragmentInstance = (value: unknown): value is AnyFragnoInstantiatedFragment =>
  Boolean(value && typeof value === "object" && "handler" in value && "callRouteRaw" in value);

const resolveServerModule = async (modulePath: string): Promise<ServerModule> => {
  const url = pathToFileURL(resolve(process.cwd(), modulePath)).href;
  const mod = (await import(url)) as ServerModule;
  return mod;
};

const resolveFragment = async (
  modulePath: string,
): Promise<{ fragment: AnyFragnoInstantiatedFragment; adapter?: InMemoryAdapter }> => {
  const mod = await resolveServerModule(modulePath);
  const candidates = [mod.default, mod.server, mod.fragment, mod.createFragment, mod] as unknown[];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (isDefinitionConfig(candidate)) {
      const adapter = new InMemoryAdapter({ idSeed: `lofi-cli-${candidate.fragmentName}` });
      const fragmentDef = defineFragment(candidate.fragmentName)
        .extend(withDatabase(candidate.schema))
        .withSyncCommands(candidate.syncCommands)
        .build();

      const fragment = instantiate(fragmentDef)
        .withConfig({})
        .withRoutes(candidate.routes ?? [])
        .withOptions({ databaseAdapter: adapter, outbox: { enabled: true } })
        .build();

      return { fragment, adapter };
    }

    if (isFragmentInstance(candidate)) {
      return { fragment: candidate };
    }

    if (typeof candidate === "function") {
      const adapter = new InMemoryAdapter({ idSeed: "lofi-cli" });
      const fragment = await candidate({ databaseAdapter: adapter, outbox: { enabled: true } });
      if (isFragmentInstance(fragment)) {
        return { fragment, adapter };
      }
    }
  }

  throw new Error("Unable to resolve server fragment from module.");
};

export const serveCommand = define({
  name: "serve",
  description: "Start a local Fragno server for Lofi testing",
  args: {
    module: {
      type: "string" as const,
      short: "m" as const,
      description: "Path to a server module exporting a fragment",
      required: true as const,
    },
    port: {
      type: "number" as const,
      short: "p" as const,
      description: "Port to listen on (default: 4100)",
    },
  },
  run: async (ctx) => {
    const modulePath = ctx.values["module"] as string;
    const port = (ctx.values["port"] as number | undefined) ?? 4100;

    const { fragment, adapter } = await resolveFragment(modulePath);
    const handler = toNodeHandler(fragment.handler.bind(fragment));
    const server = createServer(handler);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const mountRoute =
      "mountRoute" in fragment && typeof fragment.mountRoute === "string"
        ? fragment.mountRoute
        : "";
    const baseUrl = `http://127.0.0.1:${address.port}${mountRoute}`;

    const cleanup = async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      if (adapter) {
        await adapter.close();
      }
    };

    let stopping = false;
    const stop = async () => {
      if (stopping) {
        return;
      }
      stopping = true;
      try {
        await cleanup();
      } catch (err) {
        console.error("Cleanup error:", err);
      }
      process.exit(0);
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    console.log(`Lofi server listening on ${baseUrl}`);
  },
});
