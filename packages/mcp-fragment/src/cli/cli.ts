#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

import { migrate } from "@fragno-dev/db";
import { toNodeHandler } from "@fragno-dev/node";

import { createMcpFragment } from "../index";

const DEFAULT_PORT = 3927;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MOUNT_ROUTE = "/api/mcp-fragment";

const USAGE = `fragno-mcp <command> [options]

Commands:
  serve                         Run the local MCP fragment server
  add <slug> <endpoint-url>      Register a remote MCP server
  oauth <slug>                  Start OAuth and open the authorization URL
  status <slug>                 Show auth status
  tools <slug>                  List remote MCP tools

Options:
  --base-url <url>              Local fragment base URL (default: http://127.0.0.1:3927)
  --port <port>                 Server port for serve/oauth (default: 3927)
  --host <host>                 Server host for serve (default: 127.0.0.1)
  --data-dir <path>             SQLite data directory (default: ~/.fragno/mcp-fragment)
  --mount-route <path>          Fragment mount route (default: /api/mcp-fragment)
  --scope <scope>               OAuth scope
  --client-id <id>              OAuth client id
  --client-secret <secret>      OAuth client secret
  --json                        Print JSON
  --no-open                     Do not open the browser for oauth
  -h, --help                    Show help`;

type Logger = Pick<Console, "log" | "error">;

type Parsed = {
  command?: string;
  args: string[];
  options: Record<string, string | boolean>;
};

function parse(argv: string[]): Parsed {
  const args: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      options["help"] = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [rawKey, rawValue] = arg.split("=", 2);
      const key = rawKey.slice(2);
      if (key === "json" || key === "no-open") {
        options[key] = rawValue === undefined ? true : rawValue !== "false";
        continue;
      }
      const value = rawValue ?? argv[i + 1];
      if (rawValue === undefined) {
        i += 1;
      }
      options[key] = value ?? "";
      continue;
    }
    args.push(arg);
  }
  const [command, ...rest] = args;
  return { command, args: rest, options };
}

function optionString(options: Parsed["options"], key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionBoolean(options: Parsed["options"], key: string): boolean {
  return options[key] === true;
}

function localBaseUrl(options: Parsed["options"]): string {
  return (
    optionString(options, "base-url") ??
    `http://${DEFAULT_HOST}:${optionString(options, "port") ?? DEFAULT_PORT}`
  );
}

function mountRoute(options: Parsed["options"]): string {
  return optionString(options, "mount-route") ?? DEFAULT_MOUNT_ROUTE;
}

function dataDir(options: Parsed["options"]): string {
  return optionString(options, "data-dir") ?? path.join(homedir(), ".fragno", "mcp-fragment");
}

function fragmentUrl(options: Parsed["options"], route: string): string {
  return `${localBaseUrl(options).replace(/\/$/, "")}${mountRoute(options)}${route}`;
}

async function requestJson(method: string, url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : text || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function startServer(options: Parsed["options"], logger: Logger): Promise<Server> {
  const dir = dataDir(options);
  await mkdir(dir, { recursive: true });
  process.env["FRAGNO_DATA_DIR"] = dir;

  const baseUrl = localBaseUrl(options).replace(/\/$/, "");
  const fragment = createMcpFragment(
    { publicBaseUrl: `${baseUrl}${mountRoute(options)}` },
    { mountRoute: mountRoute(options), databaseNamespace: "mcp-fragment" },
  );
  logger.log("migrating sqlite database if needed...");
  await migrate(fragment);
  const handler = toNodeHandler(fragment.handler);
  const server = createServer((req, res) => {
    if (req.url?.startsWith(fragment.mountRoute)) {
      return handler(req, res);
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  });
  const port = Number(optionString(options, "port") ?? DEFAULT_PORT);
  const host = optionString(options, "host") ?? DEFAULT_HOST;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.log(`fragno-mcp listening at ${baseUrl}${fragment.mountRoute}`);
  logger.log(`sqlite data dir: ${dir}`);
  return server;
}

function openBrowser(url: string) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

function print(value: unknown, json: boolean, logger: Logger) {
  if (json) {
    logger.log(JSON.stringify(value, null, 2));
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    "tools" in value &&
    Array.isArray((value as { tools: unknown[] }).tools)
  ) {
    for (const tool of (value as { tools: unknown[] }).tools) {
      const record = tool && typeof tool === "object" ? (tool as Record<string, unknown>) : {};
      logger.log(
        `${String(record["name"] ?? "(unnamed)")}\t${String(record["description"] ?? "")}`,
      );
    }
    return;
  }
  logger.log(JSON.stringify(value, null, 2));
}

export async function run(argv: string[], logger: Logger = console): Promise<number> {
  const parsed = parse(argv.slice(2));
  if (optionBoolean(parsed.options, "help") || !parsed.command) {
    logger.log(USAGE);
    return parsed.command ? 0 : 1;
  }

  try {
    switch (parsed.command) {
      case "serve": {
        await startServer(parsed.options, logger);
        await new Promise(() => undefined);
        return 0;
      }
      case "add": {
        const [slug, endpointUrl] = parsed.args;
        if (!slug || !endpointUrl) {
          throw new Error("Usage: fragno-mcp add <slug> <endpoint-url>");
        }
        const result = await requestJson("POST", fragmentUrl(parsed.options, "/servers"), {
          slug,
          endpointUrl,
          auth: { type: "none" },
        });
        print(result, optionBoolean(parsed.options, "json"), logger);
        return 0;
      }
      case "oauth": {
        const [slug] = parsed.args;
        if (!slug) {
          throw new Error("Usage: fragno-mcp oauth <slug>");
        }
        const result = (await requestJson(
          "POST",
          fragmentUrl(parsed.options, `/servers/${encodeURIComponent(slug)}/auth/start`),
          {
            scope: optionString(parsed.options, "scope"),
            clientId: optionString(parsed.options, "client-id"),
            clientSecret: optionString(parsed.options, "client-secret"),
          },
        )) as { authorizationUrl: string };
        logger.log(`Open this URL to authorize:\n${result.authorizationUrl}`);
        if (!optionBoolean(parsed.options, "no-open")) {
          openBrowser(result.authorizationUrl);
        }
        logger.log(
          "Keep `fragno-mcp serve` running until the browser redirects back to the local callback.",
        );
        return 0;
      }
      case "status": {
        const [slug] = parsed.args;
        if (!slug) {
          throw new Error("Usage: fragno-mcp status <slug>");
        }
        print(
          await requestJson(
            "GET",
            fragmentUrl(parsed.options, `/servers/${encodeURIComponent(slug)}/auth/status`),
          ),
          optionBoolean(parsed.options, "json"),
          logger,
        );
        return 0;
      }
      case "tools": {
        const [slug] = parsed.args;
        if (!slug) {
          throw new Error("Usage: fragno-mcp tools <slug>");
        }
        print(
          await requestJson(
            "GET",
            fragmentUrl(parsed.options, `/servers/${encodeURIComponent(slug)}/tools`),
          ),
          optionBoolean(parsed.options, "json"),
          logger,
        );
        return 0;
      }
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    logger.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 1;
  }
}

const isDirectCliRun = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], "file:").href
  : false;

if (isDirectCliRun) {
  const exitCode = await run(process.argv);
  if (typeof exitCode === "number") {
    process.exitCode = exitCode;
  }
}
