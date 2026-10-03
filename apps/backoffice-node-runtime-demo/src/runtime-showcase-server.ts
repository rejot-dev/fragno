import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { GraftNodeLease } from "@fragno-private/backoffice-node-runtime/graft-control-store";
import { startNodeBackofficeAlarmScheduler } from "@fragno-private/backoffice-node-runtime/node-alarm-scheduler";
import { createAuthorityBoundGraftNodeObjectRuntime } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";

import type { createRuntimeShowcaseObject } from "./runtime-showcase-object";
import {
  prepareRuntimeShowcaseStorage,
  readRuntimeShowcaseObjectOwnership,
  releaseRuntimeShowcaseObjectClaims,
  runtimeShowcaseObjectNames,
  type RuntimeShowcaseStorage,
} from "./runtime-showcase-storage";

const runtimeShowcaseObjectDefinition = defineNodeRuntimeObject<typeof createRuntimeShowcaseObject>(
  new URL("./runtime-showcase-object.js", import.meta.url),
  "createRuntimeShowcaseObject",
);

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const config = readRuntimeShowcaseServerConfig();
const preparedStorage = await prepareRuntimeShowcaseStorage(config.dataDirectory);
const nodeLease = createRuntimeShowcaseNodeLease(config);
const runtime = createRuntimeShowcaseRuntime(preparedStorage, nodeLease);
const activeObjectIds = new Set(preparedStorage.persistedObjectIds);

const server = createServer((request, response) => {
  void serveRuntimeShowcaseRequest(request, response, {
    runtime,
    storage: preparedStorage,
    activeObjectIds,
  });
});
let shutdown: Promise<void> | null = null;

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => {
    server.off("error", reject);
    resolve();
  });
});
const alarmScheduler = startNodeBackofficeAlarmScheduler(runtime, {
  intervalMs: config.alarmIntervalMs,
  onError(error) {
    console.error("RUNTIME_SHOWCASE_ALARM_TICK_FAILED", error);
  },
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("RUNTIME_SHOWCASE_SERVER_ADDRESS_INVALID");
}
const origin = `http://${config.host}:${address.port}`;
console.log(
  `RUNTIME_SHOWCASE_SERVER_READY:${JSON.stringify({
    origin,
    dataDirectory: preparedStorage.dataDirectory,
    cacheDirectory: preparedStorage.cacheDirectory,
    remoteDirectory: preparedStorage.remoteDirectory,
    controlRemoteLogId: preparedStorage.storage.controlRemoteLogId,
    nodeId: nodeLease.nodeId,
    leaseExpiresAt: new Date(nodeLease.expiresAtMs).toISOString(),
  })}`,
);
console.log(`Runtime showcase listening at ${origin}`);

process.once("SIGINT", () => {
  void stopRuntimeShowcaseServer("SIGINT");
});
process.once("SIGTERM", () => {
  void stopRuntimeShowcaseServer("SIGTERM");
});

async function stopRuntimeShowcaseServer(signal: string): Promise<void> {
  shutdown ??= (async () => {
    console.log(`Runtime showcase stopping after ${signal}`);
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    await alarmScheduler.stop();
    await serverClosed;
    await runtime.cleanup();
    const releases = releaseRuntimeShowcaseObjectClaims({
      storage: preparedStorage.storage,
      nodeLease,
      objectIds: [...activeObjectIds],
    });
    console.log(`RUNTIME_SHOWCASE_RELEASES:${JSON.stringify(releases)}`);
  })();
  try {
    await shutdown;
    process.exitCode = 0;
  } catch (error) {
    console.error("RUNTIME_SHOWCASE_SHUTDOWN_FAILED", error);
    process.exitCode = 1;
  }
}

function createRuntimeShowcaseRuntime(storage: RuntimeShowcaseStorage, lease: GraftNodeLease) {
  return createAuthorityBoundGraftNodeObjectRuntime({
    storage: storage.storage,
    clock: { kind: "system" },
    nodeLease: lease,
    objects: { SHOWCASE: runtimeShowcaseObjectDefinition },
  });
}

type RuntimeShowcaseRuntime = ReturnType<typeof createRuntimeShowcaseRuntime>;
type RuntimeShowcaseObjectStub = ReturnType<RuntimeShowcaseRuntime["objects"]["SHOWCASE"]["get"]>;

type RuntimeShowcaseRequestContext = {
  runtime: RuntimeShowcaseRuntime;
  storage: RuntimeShowcaseStorage;
  activeObjectIds: Set<string>;
};

async function serveRuntimeShowcaseRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  context: RuntimeShowcaseRequestContext,
): Promise<void> {
  try {
    const request = await createWebRequest(incoming);
    const response = await routeRuntimeShowcaseRequest(request, context);
    await writeWebResponse(outgoing, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("RUNTIME_SHOWCASE_REQUEST_FAILED", error);
    await writeWebResponse(
      outgoing,
      Response.json({ error: message }, { status: error instanceof RequestInputError ? 400 : 500 }),
    );
  }
}

async function routeRuntimeShowcaseRequest(
  request: Request,
  context: RuntimeShowcaseRequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));

  if (request.method === "GET" && segments.length === 0) {
    return new Response(runtimeShowcaseHomePage, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "GET" && segments[0] === "health" && segments.length === 1) {
    return Response.json({ status: "ok", nodeId: nodeLease.nodeId });
  }
  if (request.method === "POST" && segments[0] === "tick" && segments.length === 1) {
    await context.runtime.tick();
    return Response.json({ ticked: true });
  }
  if (request.method === "GET" && segments[0] === "control" && segments.length === 2) {
    const name = requireObjectName(segments[1]);
    return Response.json({
      ownership: readRuntimeShowcaseObjectOwnership(
        context.storage.storage,
        runtimeShowcaseObjectId(name),
      ),
    });
  }
  if (
    request.method === "POST" &&
    segments[0] === "multi-object-increments" &&
    segments.length === 1
  ) {
    const input = await readJsonObject(request);
    const increments = requireRuntimeShowcaseObjectIncrements(input["increments"]);
    const snapshots = await context.runtime.runWithOutputGate(async () => {
      const results: unknown[] = [];
      for (const increment of increments) {
        results.push(
          await withRuntimeShowcaseObject(context, increment.name, async (object) => {
            await object.increment(increment.delta, "multi-object-output-gate");
            return await object.read();
          }),
        );
      }
      return results;
    });
    return Response.json({
      outputGate: "one external boundary, one independent durability proof per object log",
      snapshots,
    });
  }
  if (segments[0] !== "objects" || segments.length < 2) {
    return Response.json({ error: "RUNTIME_SHOWCASE_ROUTE_NOT_FOUND" }, { status: 404 });
  }

  const name = requireObjectName(segments[1]);
  if (request.method === "GET" && segments.length === 2) {
    const snapshot = await context.runtime.runWithOutputGate(async () => {
      return await withRuntimeShowcaseObject(context, name, async (object) => {
        return await object.read();
      });
    });
    return Response.json(snapshot);
  }
  if (request.method === "POST" && segments[2] === "increments" && segments.length === 3) {
    const input = await readJsonObject(request);
    const deltas = requireNumberArray(input["deltas"], "deltas");
    const label = requireString(input["label"], "label");
    const result = await context.runtime.runWithOutputGate(async () => {
      return await withRuntimeShowcaseObject(context, name, async (object) => {
        const intermediateCounts: number[] = [];
        for (const delta of deltas) {
          intermediateCounts.push(await object.increment(delta, label));
        }
        return { intermediateCounts, snapshot: await object.read() };
      });
    });
    return Response.json({ outputGate: "one external durability boundary", ...result });
  }
  if (request.method === "POST" && segments[2] === "compatibility-value" && segments.length === 3) {
    const input = await readJsonObject(request);
    const value = requireString(input["value"], "value");
    const snapshot = await withRuntimeShowcaseObject(context, name, async (object) => {
      return await object.writeCompatibilityValue(value);
    });
    return Response.json(snapshot);
  }
  if (request.method === "POST" && segments[2] === "alarm" && segments.length === 3) {
    const input = await readJsonObject(request);
    const delayMs = requireNonNegativeInteger(input["delayMs"], "delayMs");
    const result = await withRuntimeShowcaseObject(context, name, async (object) => {
      return await object.scheduleAlarm(delayMs);
    });
    return Response.json(result, { status: 202 });
  }
  if (request.method === "POST" && segments[2] === "background" && segments.length === 3) {
    const input = await readJsonObject(request);
    const note = requireString(input["note"], "note");
    const result = await withRuntimeShowcaseObject(context, name, async (object) => {
      await object.startBackgroundNote(note);
      await context.runtime.drainWaitUntil();
      return await object.read();
    });
    return Response.json(result, { status: 202 });
  }
  if (request.method === "POST" && segments[2] === "callback" && segments.length === 3) {
    const result = await withRuntimeShowcaseObject(context, name, async (object) => {
      return await object.callback(async (message) => `main thread received: ${message}`);
    });
    return Response.json({ result });
  }
  if (request.method === "POST" && segments[2] === "capability" && segments.length === 3) {
    const input = await readJsonObject(request);
    const deltas = requireNumberArray(input["deltas"], "deltas");
    const counts = await context.runtime.runWithOutputGate(async () => {
      return await withRuntimeShowcaseObject(context, name, async (object) => {
        const capability = object.operationCapability();
        try {
          const values: number[] = [];
          for (const delta of deltas) {
            values.push(await capability.increment(delta));
          }
          return values;
        } finally {
          capability[Symbol.dispose]();
        }
      });
    });
    return Response.json({ promisePipelinedCapabilityCounts: counts });
  }
  if (request.method === "POST" && segments[2] === "values" && segments.length === 3) {
    const original = {
      label: "created on main thread",
      createdAt: new Date(),
      bytes: new Uint8Array([1, 2, 3]),
      total: 9_007_199_254_740_993n,
    };
    const returned = await withRuntimeShowcaseObject(context, name, async (object) => {
      return await object.exchangeValues(original);
    });
    return Response.json({
      originalAfterRpc: serializeRuntimeShowcaseValues(original),
      returnedFromWorker: serializeRuntimeShowcaseValues(returned),
    });
  }
  if (segments[2] === "fetch") {
    const targetPath = `/${segments.slice(3).map(encodeURIComponent).join("/")}`;
    const targetUrl = new URL(targetPath, "https://runtime-showcase.object");
    targetUrl.search = url.search;
    const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    const objectRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body,
      duplex: body ? "half" : undefined,
    } as RequestInit);
    return await context.runtime.runWithOutputGate(async () => {
      return await withRuntimeShowcaseObject(context, name, async (object) => {
        return await object.fetch(objectRequest);
      });
    });
  }

  return Response.json({ error: "RUNTIME_SHOWCASE_ROUTE_NOT_FOUND" }, { status: 404 });
}

async function withRuntimeShowcaseObject<TResult>(
  context: RuntimeShowcaseRequestContext,
  name: string,
  operation: (object: RuntimeShowcaseObjectStub) => Promise<TResult>,
): Promise<TResult> {
  context.activeObjectIds.add(runtimeShowcaseObjectId(name));
  const object = context.runtime.objects.SHOWCASE.get(name);
  try {
    return await operation(object);
  } finally {
    object[Symbol.dispose]();
  }
}

function runtimeShowcaseObjectId(name: string): string {
  return `SHOWCASE:${name}`;
}

async function createWebRequest(incoming: IncomingMessage): Promise<Request> {
  const host = incoming.headers.host ?? "127.0.0.1";
  const url = new URL(incoming.url ?? "/", `http://${host}`);
  const method = incoming.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? null : await readIncomingBody(incoming);
  return new Request(url, {
    method,
    headers: createWebRequestHeaders(incoming),
    body: body && body.byteLength > 0 ? toArrayBuffer(body) : null,
  });
}

function createWebRequestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function readIncomingBody(incoming: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    byteLength += buffer.byteLength;
    if (byteLength > 1_048_576) {
      throw new RequestInputError("RUNTIME_SHOWCASE_REQUEST_BODY_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function writeWebResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    outgoing.setHeader(name, value);
  }
  if (!response.body) {
    outgoing.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(response.body as never);
    body.once("error", reject);
    outgoing.once("error", reject);
    outgoing.once("finish", resolve);
    body.pipe(outgoing);
  });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const value = (await request.json()) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestInputError("RUNTIME_SHOWCASE_JSON_OBJECT_REQUIRED");
  }
  return value as Record<string, unknown>;
}

function requireObjectName(value: string | undefined): string {
  if (
    !value ||
    !runtimeShowcaseObjectNames.includes(value as (typeof runtimeShowcaseObjectNames)[number])
  ) {
    throw new RequestInputError("RUNTIME_SHOWCASE_OBJECT_NAME_INVALID");
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RequestInputError(`RUNTIME_SHOWCASE_STRING_INVALID:${field}`);
  }
  return value;
}

function requireNumberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new RequestInputError(`RUNTIME_SHOWCASE_NUMBER_ARRAY_INVALID:${field}`);
  }
  const entries = value as unknown[];
  if (
    entries.length === 0 ||
    entries.some((entry) => typeof entry !== "number" || !Number.isSafeInteger(entry))
  ) {
    throw new RequestInputError(`RUNTIME_SHOWCASE_NUMBER_ARRAY_INVALID:${field}`);
  }
  return entries as number[];
}

function requireRuntimeShowcaseObjectIncrements(value: unknown): { name: string; delta: number }[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new RequestInputError("RUNTIME_SHOWCASE_MULTI_OBJECT_INCREMENTS_INVALID");
  }
  return (value as unknown[]).map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new RequestInputError(`RUNTIME_SHOWCASE_MULTI_OBJECT_INCREMENT_INVALID:${index}`);
    }
    const record = entry as Record<string, unknown>;
    const name = requireObjectName(typeof record["name"] === "string" ? record["name"] : undefined);
    const delta = record["delta"];
    if (typeof delta !== "number" || !Number.isSafeInteger(delta)) {
      throw new RequestInputError(`RUNTIME_SHOWCASE_MULTI_OBJECT_DELTA_INVALID:${index}`);
    }
    return { name, delta };
  });
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RequestInputError(`RUNTIME_SHOWCASE_NON_NEGATIVE_INTEGER_INVALID:${field}`);
  }
  return value;
}

function serializeRuntimeShowcaseValues(value: {
  label: string;
  createdAt: Date;
  bytes: Uint8Array;
  total: bigint;
}) {
  return {
    label: value.label,
    createdAt: value.createdAt.toISOString(),
    bytes: [...value.bytes],
    total: value.total.toString(),
  };
}

function readRuntimeShowcaseServerConfig() {
  const port = readEnvironmentInteger("BACKOFFICE_NODE_RUNTIME_DEMO_PORT", 3210, 0);
  const alarmIntervalMs = readEnvironmentInteger(
    "BACKOFFICE_NODE_RUNTIME_DEMO_ALARM_INTERVAL_MS",
    1_000,
    1,
  );
  const leaseDurationMs = readEnvironmentInteger(
    "BACKOFFICE_NODE_RUNTIME_DEMO_LEASE_DURATION_MS",
    86_400_000,
    1,
  );
  return {
    host: process.env["BACKOFFICE_NODE_RUNTIME_DEMO_HOST"] ?? "127.0.0.1",
    port,
    alarmIntervalMs,
    leaseDurationMs,
    dataDirectory: path.resolve(
      process.env["BACKOFFICE_NODE_RUNTIME_DEMO_DATA_DIR"] ?? path.join(appDirectory, ".data"),
    ),
  };
}

function readEnvironmentInteger(name: string, fallback: number, minimum: number): number {
  const source = process.env[name];
  if (source === undefined) {
    return fallback;
  }
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`RUNTIME_SHOWCASE_ENVIRONMENT_INTEGER_INVALID:${name}`);
  }
  return value;
}

function createRuntimeShowcaseNodeLease(
  serverConfig: ReturnType<typeof readRuntimeShowcaseServerConfig>,
): GraftNodeLease {
  const nodeId = randomUUID();
  return {
    nodeId,
    processGeneration: randomUUID(),
    privateAddress: `${serverConfig.host}:${serverConfig.port}`,
    compatibilityVersion: 1,
    expiresAtMs: Date.now() + serverConfig.leaseDurationMs,
    renewalId: randomUUID(),
  };
}

class RequestInputError extends Error {}

const runtimeShowcaseHomePage = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Backoffice Node Runtime Graft Showcase</title></head>
  <body>
    <main>
      <h1>Backoffice Node Runtime Graft Showcase</h1>
      <p>Authority-bound worker threads with Graft-backed SQL, KV, alarms, output gates, and Cap'n Web RPC.</p>
      <pre>
GET  /objects/demo
POST /objects/demo/increments          {"deltas":[2,3],"label":"http-output-gate"}
POST /multi-object-increments           {"increments":[{"name":"demo","delta":1},{"name":"two","delta":7}]}
POST /objects/demo/compatibility-value {"value":"durable KV"}
POST /objects/demo/alarm               {"delayMs":0}
POST /tick
POST /objects/demo/background          {"note":"waitUntil completed"}
POST /objects/demo/callback
POST /objects/demo/capability           {"deltas":[4,1]}
POST /objects/demo/values
GET  /objects/demo/fetch/stream
GET  /control/demo
      </pre>
      <p>Run the packaged walkthrough for a cache-deletion and fresh-process recovery demonstration.</p>
    </main>
  </body>
</html>`;
