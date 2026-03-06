import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

import { define } from "gunshi";
import { toNodeHandler } from "@fragno-dev/node";
import { migrate } from "@fragno-dev/db";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import { SqliteDialect } from "kysely";

import { createGitHubAppFragment } from "../../github/factory.js";
import { resolveGitHubAppConfig } from "../utils/config.js";

const resolveMountRoute = (ctx: { values: Record<string, unknown> }) =>
  (ctx.values["mount-route"] as string | undefined) ??
  process.env["FRAGNO_GITHUB_APP_MOUNT_ROUTE"] ??
  undefined;

const resolveDbPath = (ctx: { values: Record<string, unknown> }) =>
  (ctx.values["db-path"] as string | undefined) ??
  process.env["FRAGNO_GITHUB_APP_DB_PATH"] ??
  "./github-app-fragment.sqlite";

const resolvePollInterval = (ctx: { values: Record<string, unknown> }) => {
  const raw =
    (ctx.values["poll-interval"] as number | string | undefined) ??
    process.env["FRAGNO_GITHUB_APP_POLL_INTERVAL_MS"] ??
    undefined;
  if (raw === undefined) {
    return 200;
  }
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("poll-interval must be a positive number");
  }
  return numeric;
};

const loadBetterSqlite3 = () => {
  const requireFn = createRequire(import.meta.url);
  const mod = requireFn("better-sqlite3");
  return (mod.default ?? mod) as typeof import("better-sqlite3");
};

const ensureDbDir = (dbPath: string) => {
  if (dbPath === ":memory:") {
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
};

const createSqliteAdapter = (dbPath: string) => {
  ensureDbDir(dbPath);
  const BetterSqlite3 = loadBetterSqlite3();
  const db = new BetterSqlite3(dbPath);
  const dialect = new SqliteDialect({ database: db });

  return {
    adapter: new SqlAdapter({ dialect, driverConfig: new BetterSQLite3DriverConfig() }),
    close: async () => {
      db.close();
    },
  };
};

const addressToString = (server: Server, protocol: "http" | "https" = "http") => {
  const addr = server.address();
  if (!addr) {
    throw new Error("Address invalid");
  }

  if (typeof addr === "string") {
    return addr;
  }

  let host = addr.address;

  if (host === "::" || host === "0.0.0.0") {
    host = "localhost";
  }

  if (addr.family === "IPv6" && host !== "localhost") {
    host = `[${host}]`;
  }

  return `${protocol}://${host}:${addr.port}`;
};

export const serveCommand = define({
  name: "serve",
  description: "Start a local server for the GitHub app fragment",
  args: {
    host: {
      type: "string",
      short: "H",
      description: "Host to bind to (default: 127.0.0.1)",
    },
    port: {
      type: "number",
      short: "p",
      description: "Port to listen on (default: 6173)",
    },
    "mount-route": {
      type: "string",
      description: "Override mount route (env: FRAGNO_GITHUB_APP_MOUNT_ROUTE)",
    },
    "db-path": {
      type: "string",
      description: "SQLite database path (env: FRAGNO_GITHUB_APP_DB_PATH)",
    },
    "poll-interval": {
      type: "number",
      description: "Durable hooks poll interval in ms (default: 200)",
    },
    "app-id": {
      type: "string",
      description: "GitHub App ID (env: GITHUB_APP_ID)",
    },
    "app-slug": {
      type: "string",
      description: "GitHub App slug (env: GITHUB_APP_SLUG)",
    },
    "private-key": {
      type: "string",
      description: "GitHub App private key PEM (env: GITHUB_APP_PRIVATE_KEY)",
    },
    "private-key-file": {
      type: "string",
      description: "GitHub App private key PEM file (env: GITHUB_APP_PRIVATE_KEY_FILE)",
    },
    "webhook-secret": {
      type: "string",
      description: "Webhook secret (env: GITHUB_APP_WEBHOOK_SECRET)",
    },
    "webhook-debug": {
      type: "boolean",
      description: "Log webhook debug info (env: GITHUB_APP_WEBHOOK_DEBUG)",
    },
    "api-base-url": {
      type: "string",
      description: "GitHub API base URL (env: GITHUB_APP_API_BASE_URL)",
    },
    "api-version": {
      type: "string",
      description: "GitHub API version (env: GITHUB_APP_API_VERSION)",
    },
    "web-base-url": {
      type: "string",
      description: "GitHub web base URL (env: GITHUB_APP_WEB_BASE_URL)",
    },
    "default-link-key": {
      type: "string",
      description: "Default link key (env: GITHUB_APP_DEFAULT_LINK_KEY)",
    },
    "token-cache-ttl": {
      type: "number",
      description: "Token cache TTL in seconds (env: GITHUB_APP_TOKEN_CACHE_TTL_SECONDS)",
    },
  },
  run: async (ctx) => {
    const config = resolveGitHubAppConfig(ctx);
    const host = (ctx.values["host"] as string | undefined) ?? "127.0.0.1";
    const port = (ctx.values["port"] as number | undefined) ?? 6173;
    const mountRoute = resolveMountRoute(ctx);
    const pollIntervalMs = resolvePollInterval(ctx);
    const dbPath = resolveDbPath(ctx);

    const { adapter, close } = createSqliteAdapter(dbPath);

    const fragment = createGitHubAppFragment(config, {
      databaseAdapter: adapter ?? undefined,
      outbox: { enabled: true },
      mountRoute,
    });

    console.log("Running database migrations...");
    await migrate(fragment);

    const handler = toNodeHandler(fragment.handler.bind(fragment));
    const server = createServer(handler);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });

    const dispatcher = createDurableHooksProcessor([fragment], {
      pollIntervalMs,
      onError: (error) => {
        console.error("Durable hooks processing error", error);
      },
    });
    dispatcher.startPolling();

    const baseUrl = addressToString(server);
    const mount = fragment.mountRoute;
    const fragmentBase = `${baseUrl}${mount}`;

    console.log(`GitHub app fragment server running on ${baseUrl}`);
    console.log(`Fragment mount: ${mount}`);
    console.log(`Fragment base URL: ${fragmentBase}`);
    console.log(`Webhook URL: ${fragmentBase}/webhooks`);
    console.log(`Durable hooks polling: ${pollIntervalMs}ms`);
    console.log("Set FRAGNO_GITHUB_APP_BASE_URL to call routes from the CLI.");

    const cleanup = async () => {
      dispatcher.stopPolling();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await close();
    };

    let stopping = false;
    const stop = async () => {
      if (stopping) {
        return;
      }
      stopping = true;
      try {
        await cleanup();
      } catch (error) {
        console.error("Cleanup failed", error);
      } finally {
        process.exit(0);
      }
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  },
});
