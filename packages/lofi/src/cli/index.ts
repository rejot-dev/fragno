#!/usr/bin/env node

import { cli, define } from "gunshi";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { commentSchema } from "@fragno-dev/fragno-db-library";
import { upvoteSchema } from "@fragno-dev/fragno-db-library/upvote";
import { IndexedDbAdapter, LofiClient } from "../mod.js";
import type { LofiSchemaRegistration } from "../mod.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const version = packageJson.version as string;

const mainCommand = define({
  name: "fragno-lofi",
  description: "Poll a Fragno outbox and print local IndexedDB state",
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
  },
  run: async (ctx) => {
    const endpoint = ctx.values["endpoint"] as string;
    const timeoutSeconds = coerceNumber(ctx.values["timeout"], 5);
    const pollIntervalMs = coerceNumber(ctx.values["pollInterval"], 1000);
    const limit = coerceNumber(ctx.values["limit"], 500);
    const endpointOverride = ctx.values["endpointName"] as string | undefined;

    if (timeoutSeconds < 0) {
      throw new Error("timeout must be a positive number");
    }
    if (pollIntervalMs < 0) {
      throw new Error("pollInterval must be a positive number");
    }
    if (limit < 1) {
      throw new Error("limit must be >= 1");
    }

    const outboxUrl = buildOutboxUrl(endpoint);
    const endpointName = endpointOverride ?? deriveEndpointName(outboxUrl);
    const schemas = ALL_SCHEMAS;

    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;

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

const printHelp = () => {
  console.log("Fragno Lofi outbox poller");
  console.log("");
  console.log("USAGE:");
  console.log("  fragno-lofi --endpoint <url> [options]");
  console.log("");
  console.log("OPTIONS:");
  console.log("  -e, --endpoint       Fragment base URL or outbox URL (required)");
  console.log("  -t, --timeout        Seconds to run (default: 5)");
  console.log("  -i, --poll-interval  Poll interval in ms (default: 1000)");
  console.log("  --limit              Outbox page size (default: 500)");
  console.log("  --endpoint-name      Override local endpoint name");
  console.log("  -v, --version        Print version");
  console.log("  -h, --help           Show help");
  console.log("");
  console.log("EXAMPLES:");
  console.log("  fragno-lofi --endpoint http://localhost:3000/api/fragno-db-comment --timeout 5");
  console.log("  fragno-lofi --endpoint http://localhost:3000/api/fragno-db-rating --timeout 5");
};

export async function run() {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(version);
    return;
  }

  await cli(args, mainCommand, {
    name: "fragno-lofi",
    version,
  });
}

const ALL_SCHEMAS: LofiSchemaRegistration[] = [{ schema: commentSchema }, { schema: upvoteSchema }];

function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function buildOutboxUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.pathname.endsWith("/_internal/outbox")) {
    return url.toString();
  }
  const trimmed = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${trimmed}/_internal/outbox`;
  return url.toString();
}

function deriveEndpointName(outboxUrl: string): string {
  const url = new URL(outboxUrl);
  const raw = `${url.host}${url.pathname.replace(/\/_internal\/outbox$/, "")}`;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "lofi-endpoint";
}

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

const openDb = (name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const getAllRows = async (db: IDBDatabase): Promise<LofiRow[]> => {
  const tx = db.transaction("lofi_rows", "readonly");
  const store = tx.objectStore("lofi_rows");
  const rows = await requestToPromise<unknown[]>(store.getAll());
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return rows as LofiRow[];
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

if (import.meta.main) {
  await run();
}
