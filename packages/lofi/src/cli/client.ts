import { define } from "gunshi";
import { openDB, type IDBPDatabase } from "idb";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commentSchema } from "@fragno-dev/fragno-db-library";
import { upvoteSchema } from "@fragno-dev/fragno-db-library/upvote";
import type { AnySchema } from "@fragno-dev/db/schema";
import { IndexedDbAdapter, LofiClient, LofiSubmitClient } from "../mod.js";
import type { LofiSchemaRegistration, LofiSubmitCommandDefinition } from "../types.js";
import { buildOutboxUrl, coerceNumber, deriveEndpointName, formatError, sleep } from "./utils.js";
import { installIndexedDbGlobals } from "./utils.js";

type ClientModule = {
  schemas?: LofiSchemaRegistration[] | Array<{ schema: unknown }> | unknown[];
  schema?: unknown;
  commands?: LofiSubmitCommandDefinition[];
  createCommandContext?: (command: LofiSubmitCommandDefinition<unknown, unknown>) => unknown;
  endpointName?: string;
};

type LofiRow = {
  endpoint: string;
  schema: string;
  table: string;
  id: string;
  data: Record<string, unknown>;
  _lofi: {
    versionstamp: string;
    norm: Record<string, unknown>;
    internalId: number;
    version: number;
  };
};

const ALL_SCHEMAS: LofiSchemaRegistration[] = [{ schema: commentSchema }, { schema: upvoteSchema }];

const openDb = (name: string): Promise<IDBPDatabase> => openDB(name);

const getAllRows = async (db: IDBPDatabase): Promise<LofiRow[]> => {
  const tx = db.transaction("lofi_rows", "readonly");
  const store = tx.objectStore("lofi_rows");
  const rows = (await store.getAll()) as LofiRow[];
  await tx.done;
  return rows;
};

const normalizeSchemas = (value: unknown, fallback: LofiSchemaRegistration[]) => {
  if (!value) {
    return fallback;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry && typeof entry === "object" && "schema" in entry) {
        return entry as LofiSchemaRegistration;
      }
      return { schema: entry } as LofiSchemaRegistration;
    });
  }
  if (value && typeof value === "object" && "schema" in value) {
    return [value as LofiSchemaRegistration];
  }
  return [{ schema: value } as LofiSchemaRegistration];
};

const resolveModule = async (modulePath: string): Promise<ClientModule> => {
  const url = pathToFileURL(resolve(process.cwd(), modulePath)).href;
  const mod = (await import(url)) as ClientModule & {
    default?: ClientModule;
  };
  return (mod.default ?? mod) as ClientModule;
};

const parseJsonInput = (raw: string | undefined) => {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse JSON input: ${String(error)}`);
  }
};

export const clientCommand = define({
  name: "client",
  description: "Run a Lofi client to sync and submit commands",
  args: {
    endpoint: {
      type: "string" as const,
      short: "e" as const,
      description: "Fragment base URL or outbox URL",
      required: true as const,
    },
    timeout: {
      type: "number" as const,
      short: "t" as const,
      description: "Seconds to run (default: 5)",
    },
    pollInterval: {
      type: "number" as const,
      short: "i" as const,
      description: "Poll interval in ms (default: 1000)",
    },
    limit: {
      type: "number" as const,
      description: "Outbox page size (default: 500)",
    },
    endpointName: {
      type: "string" as const,
      description: "Override local endpoint name",
    },
    module: {
      type: "string" as const,
      description: "Path to a client module that exports schemas/commands",
    },
    command: {
      type: "string" as const,
      description: "Command name to queue before syncing",
    },
    input: {
      type: "string" as const,
      description: "JSON input payload for the queued command",
    },
    submit: {
      type: "boolean" as const,
      description: "Submit queued commands before syncing",
    },
    "no-optimistic": {
      type: "boolean" as const,
      description: "Disable optimistic execution for queued commands",
    },
  },
  run: async (ctx) => {
    const endpoint = ctx.values["endpoint"] as string;
    const timeoutSeconds = coerceNumber(ctx.values["timeout"], 5);
    const pollIntervalMs = coerceNumber(ctx.values["pollInterval"], 1000);
    const limit = coerceNumber(ctx.values["limit"], 500);
    const endpointOverride = ctx.values["endpointName"] as string | undefined;
    const modulePath = ctx.values["module"] as string | undefined;
    const commandName = ctx.values["command"] as string | undefined;
    const inputRaw = ctx.values["input"] as string | undefined;
    const submitQueued = Boolean(ctx.values["submit"]);
    const optimistic = !ctx.values["no-optimistic"];

    if (timeoutSeconds < 0) {
      throw new Error("timeout must be a positive number");
    }
    if (pollIntervalMs < 0) {
      throw new Error("pollInterval must be a positive number");
    }
    if (limit < 1) {
      throw new Error("limit must be >= 1");
    }

    installIndexedDbGlobals();

    const outboxUrl = buildOutboxUrl(endpoint);
    const moduleConfig = modulePath ? await resolveModule(modulePath) : undefined;
    const schemas =
      normalizeSchemas(moduleConfig?.schemas ?? moduleConfig?.schema, ALL_SCHEMAS) ?? ALL_SCHEMAS;

    const endpointName =
      endpointOverride ?? moduleConfig?.endpointName ?? deriveEndpointName(outboxUrl);

    const dbName = `fragno_lofi_${endpointName}`;
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName,
      schemas,
      ignoreUnknownSchemas: true,
    });

    const client = new LofiClient({
      outboxUrl,
      endpointName,
      adapter,
      pollIntervalMs,
      limit,
    });

    let submitClient: LofiSubmitClient<unknown> | undefined;
    const commands = moduleConfig?.commands ?? [];
    if (commands.length > 0) {
      submitClient = new LofiSubmitClient({
        endpointName,
        submitUrl: outboxUrl.replace(/\/_internal\/outbox$/, "/_internal/sync"),
        internalUrl: outboxUrl.replace(/\/_internal\/outbox$/, "/_internal"),
        adapter,
        schemas: schemas.map((entry) => entry.schema) as AnySchema[],
        commands,
        ...(moduleConfig?.createCommandContext
          ? { createCommandContext: moduleConfig.createCommandContext }
          : {}),
      });
    }

    const parsedInput = parseJsonInput(inputRaw);
    let lastSubmit: unknown;

    if (commandName) {
      if (!submitClient) {
        throw new Error("Missing client module with commands for --command.");
      }
      const command = commands.find((entry) => entry.name === commandName);
      if (!command) {
        throw new Error(`Unknown command: ${commandName}`);
      }

      await submitClient.queueCommand({
        name: command.name,
        target: command.target,
        input: parsedInput ?? {},
        optimistic,
      });
    }

    if (submitQueued) {
      if (!submitClient) {
        throw new Error("Missing client module with commands for --submit.");
      }
      lastSubmit = await submitClient.submitOnce();
    }

    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastResult: { appliedEntries: number; lastVersionstamp?: string } | undefined;
    let syncError: string | undefined;

    while (Date.now() < deadline) {
      try {
        lastResult = await client.syncOnce();
      } catch (error) {
        syncError = formatError(error);
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      if (pollIntervalMs > 0) {
        await sleep(Math.min(pollIntervalMs, remaining));
      }
    }

    const db = await openDb(dbName);
    const rows = await getAllRows(db);

    const output = {
      endpoint: outboxUrl,
      endpointName,
      appliedEntries: lastResult?.appliedEntries ?? 0,
      lastVersionstamp: lastResult?.lastVersionstamp,
      error: syncError,
      submit: lastSubmit,
      rows: rows.map((row) => ({
        endpoint: row.endpoint,
        schema: row.schema,
        table: row.table,
        id: row.id,
        data: row.data,
        meta: row._lofi,
      })),
    };

    console.log(JSON.stringify(output, null, 2));
  },
});
