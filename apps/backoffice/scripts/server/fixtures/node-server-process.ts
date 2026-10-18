import { assert, expect } from "vitest";

import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** Reserves a real loopback port for a Backoffice process scenario. */
export async function reserveBackofficeTestPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return port;
}

/** Sends authoritative Host headers through a real socket rather than fetch's header rewriting. */
export function sendBackofficeProxyRequest(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode }));
      });
    });
    request.once("error", reject);
    request.end();
  });
}

/** Starts a production entrypoint or supervisor and requires a clean graceful shutdown. */
export async function startBackofficeServerProcess(options: {
  entrypoint: URL;
  workingDirectory: string;
  origin: string;
  environment: Record<string, string>;
  readinessPath: string;
  startupMessages: readonly string[];
}) {
  const child = spawn(process.execPath, [fileURLToPath(options.entrypoint)], {
    cwd: options.workingDirectory,
    env: { ...process.env, ...options.environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-50_000);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-50_000);
  });
  const exit = once(child, "exit");
  async function stop(): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 12_000);
    try {
      const [code, signal] = await exit;
      expect(code, `Backoffice exit signal ${signal}:\n${logs}`).toBe(0);
    } finally {
      clearTimeout(timeout);
    }
  }
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`BACKOFFICE_SCENARIO_PROCESS_EXITED:\n${logs}`);
      }
      const ready = await fetch(`${options.origin}${options.readinessPath}`).catch(() => null);
      if (
        ready?.status === 200 &&
        options.startupMessages.every((message) => logs.includes(message))
      ) {
        return { origin: options.origin, stop, readLogs: () => logs };
      }
      await delay(25);
    }
    throw new Error(`BACKOFFICE_SCENARIO_PROCESS_START_TIMED_OUT:\n${logs}`);
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
