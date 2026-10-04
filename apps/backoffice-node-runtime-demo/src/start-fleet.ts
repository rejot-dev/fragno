import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAdaptorServer } from "@hono/node-server";

import { createFleetApp } from "./fleet/fleet-app";
import { FleetSupervisor } from "./fleet/fleet-supervisor";
import { provisionFilesystemGraftStorage } from "./fleet/local-filesystem-graft-storage";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const config = readFleetServerConfig(process.argv.slice(2));
await provisionFilesystemGraftStorage(config.dataDirectory);
const supervisor = await FleetSupervisor.start({
  dataDirectory: config.dataDirectory,
  nodeCount: config.nodeCount,
  peerAuthenticationSecret: config.peerAuthenticationSecret,
  alarmIntervalMs: config.alarmIntervalMs,
  leaseDurationMs: config.leaseDurationMs,
});
const app = createFleetApp(supervisor);
const server = createAdaptorServer({ fetch: app.fetch }) as HttpServer;

try {
  await listenFleetServer(server, config.host, config.port);
} catch (error) {
  await supervisor.close();
  throw error;
}

const address = server.address() as AddressInfo;
const publicHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
const publicOrigin = `http://${publicHost}:${address.port}`;
let shutdown: Promise<void> | null = null;

console.log(
  `DEMO_FLEET_READY:${JSON.stringify({
    origin: publicOrigin,
    nodeCount: config.nodeCount,
    dataDirectory: config.dataDirectory,
  })}`,
);
console.log(`Runtime demo fleet switchboard listening at ${publicOrigin}`);

process.once("SIGINT", () => {
  void stopFleetServer("SIGINT");
});
process.once("SIGTERM", () => {
  void stopFleetServer("SIGTERM");
});

async function stopFleetServer(signal: string): Promise<void> {
  shutdown ??= (async () => {
    console.log(`Runtime demo fleet stopping after ${signal}`);
    await closeFleetListener(server);
    await supervisor.close();
  })();
  try {
    await shutdown;
    process.exitCode = 0;
  } catch (error) {
    console.error("DEMO_FLEET_SHUTDOWN_FAILED", error);
    process.exitCode = 1;
  }
}

function readFleetServerConfig(arguments_: string[]) {
  let nodeCount = readEnvironmentInteger("BACKOFFICE_NODE_RUNTIME_DEMO_NODE_COUNT", 3, 1);
  let port = readEnvironmentInteger("BACKOFFICE_NODE_RUNTIME_DEMO_FLEET_PORT", 3210, 0);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--nodes") {
      nodeCount = readCommandLineInteger(arguments_[index + 1], "--nodes", 1);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--nodes=")) {
      nodeCount = readCommandLineInteger(argument.slice("--nodes=".length), "--nodes", 1);
      continue;
    }
    if (argument === "--port") {
      port = readCommandLineInteger(arguments_[index + 1], "--port", 0);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--port=")) {
      port = readCommandLineInteger(argument.slice("--port=".length), "--port", 0);
      continue;
    }
    throw new Error(`DEMO_FLEET_ARGUMENT_UNKNOWN:${argument}`);
  }
  if (nodeCount > 16) {
    throw new Error("DEMO_FLEET_NODE_COUNT_TOO_LARGE:16");
  }
  const dataDirectory = path.resolve(
    process.env["BACKOFFICE_NODE_RUNTIME_DEMO_DATA_DIR"] ?? path.join(appDirectory, ".data"),
  );
  return {
    host: process.env["BACKOFFICE_NODE_RUNTIME_DEMO_FLEET_HOST"] ?? "127.0.0.1",
    port,
    nodeCount,
    dataDirectory,
    alarmIntervalMs: readEnvironmentInteger(
      "BACKOFFICE_NODE_RUNTIME_DEMO_ALARM_INTERVAL_MS",
      1_000,
      1,
    ),
    leaseDurationMs: readEnvironmentInteger(
      "BACKOFFICE_NODE_RUNTIME_DEMO_LEASE_DURATION_MS",
      10_000,
      2_001,
    ),
    peerAuthenticationSecret:
      process.env["BACKOFFICE_NODE_RUNTIME_DEMO_PEER_AUTHENTICATION_SECRET"] ??
      `demo-fleet-${randomUUID()}-${randomUUID()}`,
  };
}

function readCommandLineInteger(
  source: string | undefined,
  argumentName: string,
  minimum: number,
): number {
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`DEMO_FLEET_ARGUMENT_INTEGER_INVALID:${argumentName}`);
  }
  return value;
}

function readEnvironmentInteger(name: string, fallback: number, minimum: number): number {
  const source = process.env[name];
  if (source === undefined) {
    return fallback;
  }
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`DEMO_ENVIRONMENT_INTEGER_INVALID:${name}`);
  }
  return value;
}

async function listenFleetServer(server: HttpServer, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    function handleError(error: Error): void {
      server.off("listening", handleListening);
      reject(error);
    }
    function handleListening(): void {
      server.off("error", handleError);
      resolve();
    }
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
}

async function closeFleetListener(server: HttpServer): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  server.closeIdleConnections?.();
  await closed;
}
