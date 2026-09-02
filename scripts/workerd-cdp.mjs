#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import WebSocket from "ws";

const DEFAULT_INSPECTOR_URL = "http://localhost:9229";
const DEFAULT_ORIGIN = "http://localhost";
const COMMAND_TIMEOUT_MS = 30_000;
const HEAP_SNAPSHOT_TIMEOUT_MS = 5 * 60_000;

function printUsage() {
  console.log(`Usage: node scripts/workerd-cdp.mjs <command> [arguments]

Commands:
  list
      List workerd debugger targets.

  heap-snapshot <target> [output.heapsnapshot]
      Stream a V8 heap snapshot to disk. The target may be a worker name,
      target ID prefix, or unique title substring.

  send <target> <method> [params-json]
      Send one Chrome DevTools Protocol command and print its result.

Environment:
  WORKERD_CDP_URL       Inspector discovery URL (default: ${DEFAULT_INSPECTOR_URL})
  WORKERD_CDP_ORIGIN    WebSocket Origin header (default: ${DEFAULT_ORIGIN})`);
}

function getInspectorUrl() {
  const inspectorUrl = new URL(process.env.WORKERD_CDP_URL ?? DEFAULT_INSPECTOR_URL);
  if (inspectorUrl.protocol !== "http:" && inspectorUrl.protocol !== "https:") {
    throw new Error("WORKERD_CDP_URL must use http or https");
  }
  return inspectorUrl;
}

async function listWorkerdTargets(inspectorUrl) {
  const response = await fetch(new URL("/json/list", inspectorUrl));
  if (!response.ok) {
    throw new Error(`Workerd CDP discovery failed: ${response.status} ${response.statusText}`);
  }

  const targets = await response.json();
  if (!Array.isArray(targets)) {
    throw new Error("Workerd CDP discovery returned an invalid target list");
  }
  return targets;
}

function getWorkerName(target) {
  return new URL(target.webSocketDebuggerUrl).pathname.replace(/^\//, "");
}

function resolveWorkerdTarget(targetQuery, targets) {
  const normalizedQuery = targetQuery.toLowerCase();
  const exactMatches = targets.filter((target) =>
    [target.id, target.title, getWorkerName(target)].some(
      (value) => value.toLowerCase() === normalizedQuery,
    ),
  );
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const prefixMatches = targets.filter(
    (target) =>
      target.id.toLowerCase().startsWith(normalizedQuery) ||
      target.title.toLowerCase().includes(normalizedQuery) ||
      getWorkerName(target).toLowerCase().startsWith(normalizedQuery),
  );
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Workerd CDP target is ambiguous: ${targetQuery}`);
  }
  throw new Error(`Workerd CDP target not found: ${targetQuery}`);
}

class WorkerdCdpClient {
  constructor(webSocketDebuggerUrl) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.nextCommandId = 0;
    this.pendingCommands = new Map();
    this.eventHandlers = new Map();
  }

  async connect() {
    this.webSocket = new WebSocket(this.webSocketDebuggerUrl, {
      origin: process.env.WORKERD_CDP_ORIGIN ?? DEFAULT_ORIGIN,
    });
    this.webSocket.on("message", (data) => {
      this.handleMessage(data);
    });

    await new Promise((resolveConnection, rejectConnection) => {
      this.webSocket.once("open", resolveConnection);
      this.webSocket.once("unexpected-response", (_request, response) => {
        rejectConnection(new Error(`Workerd CDP WebSocket rejected: HTTP ${response.statusCode}`));
      });
      this.webSocket.once("error", rejectConnection);
      this.webSocket.once("close", (code, reason) => {
        rejectConnection(createDebuggerClosedError(code, reason));
      });
    });

    this.webSocket.on("close", (code, reason) => {
      const error = createDebuggerClosedError(code, reason);
      for (const command of this.pendingCommands.values()) {
        command.reject(error);
      }
      this.pendingCommands.clear();
    });
  }

  handleMessage(data) {
    const message = JSON.parse(data.toString());
    if (message.method) {
      for (const handler of this.eventHandlers.get(message.method) ?? []) {
        handler(message.params ?? {});
      }
    }

    const command = this.pendingCommands.get(message.id);
    if (!command) {
      return;
    }
    this.pendingCommands.delete(message.id);
    clearTimeout(command.timeout);
    if (message.error) {
      command.reject(new Error(`Workerd CDP ${command.method} failed: ${message.error.message}`));
    } else {
      command.resolve(message.result ?? {});
    }
  }

  sendCommand(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    const id = ++this.nextCommandId;
    return new Promise((resolveCommand, rejectCommand) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        rejectCommand(new Error(`Workerd CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingCommands.set(id, {
        method,
        resolve: resolveCommand,
        reject: rejectCommand,
        timeout,
      });
      this.webSocket.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(method, handler) {
    const handlers = this.eventHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventHandlers.delete(method);
      }
    };
  }

  close() {
    this.webSocket.close();
  }
}

function createDebuggerClosedError(code, reason) {
  const closeReason = reason.toString() || "no reason";
  const singleClientHint =
    code === 1013
      ? "; close the existing DevTools session because workerd permits one debugger client"
      : "";
  return new Error(`Workerd CDP debugger closed (${code}: ${closeReason})${singleClientHint}`);
}

async function takeWorkerdHeapSnapshot(client, outputPath) {
  const output = createWriteStream(outputPath, { encoding: "utf8" });
  let chunkCount = 0;
  const stopCollectingChunks = client.onEvent(
    "HeapProfiler.addHeapSnapshotChunk",
    function writeHeapSnapshotChunk(params) {
      output.write(params.chunk);
      chunkCount++;
    },
  );

  try {
    await client.sendCommand("HeapProfiler.enable");
    await client.sendCommand(
      "HeapProfiler.takeHeapSnapshot",
      { reportProgress: false, captureNumericValue: true },
      HEAP_SNAPSHOT_TIMEOUT_MS,
    );
    await new Promise((resolveOutput, rejectOutput) => {
      output.end((error) => {
        if (error) {
          rejectOutput(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolveOutput();
      });
    });
  } catch (error) {
    output.destroy();
    await unlink(outputPath).catch(() => {});
    throw error;
  } finally {
    stopCollectingChunks();
  }

  const file = await stat(outputPath);
  return { outputPath, bytes: file.size, chunkCount };
}

function getDefaultHeapSnapshotPath(target) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(`${getWorkerName(target)}-${timestamp}.heapsnapshot`);
}

async function runListCommand(inspectorUrl) {
  const targets = await listWorkerdTargets(inspectorUrl);
  for (const target of targets) {
    console.log(`${getWorkerName(target)}\t${target.id}\t${target.title}`);
  }
}

async function runHeapSnapshotCommand(inspectorUrl, targetQuery, outputArgument) {
  if (!targetQuery) {
    throw new Error("heap-snapshot requires a target");
  }
  const target = resolveWorkerdTarget(targetQuery, await listWorkerdTargets(inspectorUrl));
  const outputPath = outputArgument ? resolve(outputArgument) : getDefaultHeapSnapshotPath(target);
  const client = new WorkerdCdpClient(target.webSocketDebuggerUrl);
  await client.connect();

  try {
    console.error(`Taking heap snapshot for ${getWorkerName(target)}...`);
    const result = await takeWorkerdHeapSnapshot(client, outputPath);
    console.log(result.outputPath);
    console.log(`Heap snapshot saved: ${result.bytes} bytes in ${result.chunkCount} chunks`);
  } finally {
    client.close();
  }
}

async function runSendCommand(inspectorUrl, targetQuery, method, paramsJson) {
  if (!targetQuery || !method) {
    throw new Error("send requires a target and CDP method");
  }
  const target = resolveWorkerdTarget(targetQuery, await listWorkerdTargets(inspectorUrl));
  const params = paramsJson ? JSON.parse(paramsJson) : {};
  const client = new WorkerdCdpClient(target.webSocketDebuggerUrl);
  await client.connect();

  try {
    const result = await client.sendCommand(method, params);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    client.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const inspectorUrl = getInspectorUrl();
  if (command === "list") {
    return runListCommand(inspectorUrl);
  }
  if (command === "heap-snapshot") {
    return runHeapSnapshotCommand(inspectorUrl, args[0], args[1]);
  }
  if (command === "send") {
    return runSendCommand(inspectorUrl, args[0], args[1], args[2]);
  }
  throw new Error(`Unknown workerd CDP command: ${command}`);
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
