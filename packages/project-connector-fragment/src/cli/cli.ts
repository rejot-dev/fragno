#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";

import { z } from "zod";

import { migrate } from "@fragno-dev/db";

import { createProjectConnectorFragment } from "../index";
import {
  projectConnectorConnectionSchema,
  projectConnectorHttpUrlSchema,
} from "../project-connector-contracts";
import { resolveAuthorizationBrowserLaunch } from "./authorization-browser";

const USAGE = `fragno-project-connector <command> [options]

Commands:
  check                         Verify gateway reachability and project-key authentication
  connect <service>             Authorize an account, wait, and verify its read-only profile
  status <request-id>           Refresh a saved authorization request
  accounts                      List this user's locally verified account bindings
  profile <account-id>          Read a connected account's provider profile
  execute <account-id> <action> Execute an action (may have side effects)

Options:
  --env-file <path>             Load OOMOL_CONNECTOR_BASE_URL / OOMOL_PROJECT_API_KEY
  --user-id <id>                Product user for the local CLI (default: cli-user)
  --connection-name <name>       Explicit connection name for connect (default: work)
  --provider-config-id <id>     Select a provider config instead of resolving the service
  --data-dir <path>             SQLite storage (default: ~/.fragno/project-connector-fragment)
  --port <port>                 Loopback OAuth return port (default: 3930)
  --timeout-ms <ms>             Maximum OAuth wait (default: 600000)
  --input <json>                Action input object (default: {})
  --no-open                    Print the authorization link without opening it
  --beep                       Play a sound when browser authorization is needed
  -h, --help                   Show help

The key remains in this process. Commands exercise the fragment's real HTTP handler
and persist verified bindings in SQLite. Do not expose this local CLI as an app server.`;

function openAuthorizationBrowser(url: string) {
  const { command, args } = resolveAuthorizationBrowserLaunch(process.platform, url);
  const child = spawn(command, args, {
    stdio: "ignore",
    detached: true,
    shell: false,
    windowsHide: true,
  });
  child.on("error", () => {
    console.error("Project Connector CLI: could not open browser; open the printed URL manually.");
  });
  child.unref();
}

function playAuthorizationBeep() {
  process.stdout.write("\u0007");
  if (process.platform === "darwin") {
    const child = spawn("afplay", ["/System/Library/Sounds/Glass.aiff"], { stdio: "ignore" });
    child.on("error", () => undefined);
  }
}

/** Runs local connector commands through the same fragment HTTP boundary as an application. */
export async function runProjectConnectorCli(
  argv: string[],
  logger: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  try {
    const parsed = parseArgs({
      args: argv[0] === "--" ? argv.slice(1) : argv,
      allowPositionals: true,
      options: {
        "env-file": { type: "string", default: "" },
        "user-id": { type: "string", default: "cli-user" },
        "connection-name": { type: "string", default: "work" },
        "provider-config-id": { type: "string", default: "" },
        "data-dir": {
          type: "string",
          default: path.join(homedir(), ".fragno", "project-connector-fragment"),
        },
        port: { type: "string", default: "3930" },
        "timeout-ms": { type: "string", default: "600000" },
        input: { type: "string", default: "{}" },
        "no-open": { type: "boolean", default: false },
        beep: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    const [command, ...args] = parsed.positionals;
    if (parsed.values.help || !command) {
      logger.log(USAGE);
      return 0;
    }
    if (!["check", "connect", "status", "accounts", "profile", "execute"].includes(command)) {
      throw new Error("Project Connector CLI: unknown command");
    }
    if (
      (["connect", "status", "profile"].includes(command) && args.length !== 1) ||
      (command === "execute" && args.length !== 2) ||
      (["check", "accounts"].includes(command) && args.length !== 0)
    ) {
      throw new Error("Project Connector CLI: invalid command arguments; use --help");
    }
    const envFile = parsed.values["env-file"];
    const env = { ...(envFile ? parseEnv(await readFile(envFile, "utf8")) : {}), ...process.env };
    const baseUrl = projectConnectorHttpUrlSchema.parse(env["OOMOL_CONNECTOR_BASE_URL"]);
    const apiKey = z.string().min(1).parse(env["OOMOL_PROJECT_API_KEY"]);
    const externalUserId = z.string().min(1).parse(parsed.values["user-id"]);
    const port = z.coerce.number().int().min(1).max(65535).parse(parsed.values.port);
    const timeoutMs = z.coerce
      .number()
      .int()
      .positive()
      .max(600_000)
      .parse(parsed.values["timeout-ms"]);
    const returnUri = `http://127.0.0.1:${port}/connected`;
    const dataDir = parsed.values["data-dir"];
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    process.env["FRAGNO_DATA_DIR"] = dataDir;
    const fragment = createProjectConnectorFragment(
      {
        baseUrl,
        apiKey,
        catalogApiKey: env["OOMOL_CONNECTOR_CATALOG_API_KEY"]?.trim() || null,
        getExternalUserId: () => externalUserId,
        allowedReturnUrls: (url) => url.toString() === returnUri,
      },
      { databaseNamespace: "project-connector-fragment" },
    );
    try {
      await migrate(fragment);
      async function call(
        method: "GET" | "POST",
        route: string,
        body: unknown = null,
      ): Promise<unknown> {
        const response = await fragment.handler(
          new Request(`http://localhost${fragment.mountRoute}${route}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
          }),
        );
        if (!response) {
          throw new Error("Project Connector CLI: fragment did not handle the request");
        }
        const result: unknown = await response.json();
        if (!response.ok) {
          const failure = z.object({ code: z.string(), message: z.string() }).parse(result);
          throw new Error(`Project Connector CLI: ${failure.code}: ${failure.message}`);
        }
        return result;
      }
      switch (command) {
        case "check":
          logger.log(JSON.stringify(await call("GET", "/status"), null, 2));
          break;
        case "status":
          logger.log(
            JSON.stringify(
              await call("POST", `/connection-requests/${encodeURIComponent(args[0])}/refresh`),
              null,
              2,
            ),
          );
          break;
        case "accounts": {
          let cursor: string | null = null;
          do {
            const page = z
              .object({ accounts: z.array(z.unknown()), cursor: z.string().nullable() })
              .parse(
                await call(
                  "GET",
                  `/accounts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
                ),
              );
            for (const account of page.accounts) {
              logger.log(JSON.stringify(account, null, 2));
            }
            cursor = page.cursor;
          } while (cursor);
          break;
        }
        case "profile":
          logger.log(
            JSON.stringify(
              await call("GET", `/accounts/${encodeURIComponent(args[0])}/profile`),
              null,
              2,
            ),
          );
          break;
        case "execute": {
          const input = z.record(z.string(), z.unknown()).parse(JSON.parse(parsed.values.input));
          logger.log(
            JSON.stringify(
              await call(
                "POST",
                `/accounts/${encodeURIComponent(args[0])}/actions/${encodeURIComponent(args[1])}`,
                { input },
              ),
              null,
              2,
            ),
          );
          break;
        }
        case "connect": {
          // The return page is navigation only. Account binding happens exclusively
          // through polling the saved request with the backend project key.
          const callback = createServer((req, res) => {
            if (req.url?.split("?")[0] !== "/connected") {
              res.writeHead(404).end("Not found");
              return;
            }
            res
              .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
              .end("Return to the terminal. It will verify your connection securely.");
          });
          await new Promise<void>((resolve, reject) => {
            callback.once("error", reject);
            callback.listen(port, "127.0.0.1", resolve);
          });
          try {
            const providerConfigId = parsed.values["provider-config-id"];
            const connection = projectConnectorConnectionSchema.parse(
              await call("POST", "/connection-requests", {
                ...(providerConfigId ? { providerConfigId } : { service: args[0] }),
                connectionName: parsed.values["connection-name"],
                returnUri,
              }),
            );
            logger.log(
              `Connection request: ${connection.id}\nAuthorize in your browser:\n${connection.authorizationUrl}`,
            );
            if (parsed.values.beep) {
              playAuthorizationBeep();
            }
            if (!parsed.values["no-open"]) {
              openAuthorizationBrowser(connection.authorizationUrl);
            }
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              const refreshed = projectConnectorConnectionSchema.parse(
                await call(
                  "POST",
                  `/connection-requests/${encodeURIComponent(connection.id)}/refresh`,
                ),
              );
              if (refreshed.state.status === "connected") {
                logger.log(`Connected account: ${refreshed.state.connectedAccountId}`);
                logger.log(
                  JSON.stringify(
                    await call(
                      "GET",
                      `/accounts/${encodeURIComponent(refreshed.state.connectedAccountId)}/profile`,
                    ),
                    null,
                    2,
                  ),
                );
                return 0;
              }
              if (refreshed.state.status !== "initiated") {
                throw new Error(`Project Connector CLI: authorization ${refreshed.state.status}`);
              }
              await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
            }
            throw new Error(
              `Project Connector CLI: authorization timed out; resume with status ${connection.id}`,
            );
          } finally {
            callback.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              callback.close((error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            });
          }
        }
      }
      return 0;
    } finally {
      await fragment.$internal.deps.databaseAdapter.close();
    }
  } catch (error) {
    logger.error(
      error instanceof z.ZodError
        ? "Project Connector CLI: invalid configuration or input; check environment variables and --help"
        : error instanceof Error
          ? error.message
          : "Project Connector CLI: command failed",
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runProjectConnectorCli(process.argv.slice(2));
}
