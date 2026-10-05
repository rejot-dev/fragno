import type { AuthorityBoundGraftNodeObjectRuntime } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { demoObjectDefinition } from "../objects/demo-object-definition";
import {
  handleNodeFetchFailure,
  NodeRequestInputError,
  requireDemoObjectName,
} from "./node-request-boundary";

type DemoObjectRuntime = AuthorityBoundGraftNodeObjectRuntime<{
  SHOWCASE: typeof demoObjectDefinition;
}>;

type NodeRequestContext = {
  runtime: DemoObjectRuntime;
};

type NodeHonoEnvironment = {
  Variables: {
    requestContext: NodeRequestContext;
  };
};

/** Application-only object routes; inspection and administration are mounted on internal ingress. */
export function createNodeApp(requestContext: NodeRequestContext) {
  const app = new Hono<NodeHonoEnvironment>();

  app.use("*", async function attachNodeRequestContext(context, next) {
    context.set("requestContext", requestContext);
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 1_048_576,
      onError() {
        throw new NodeRequestInputError("DEMO_REQUEST_BODY_TOO_LARGE");
      },
    }),
  );

  app.onError((error) => {
    return handleNodeFetchFailure(error);
  });
  app.notFound((context) => {
    return context.json({ error: "DEMO_ROUTE_NOT_FOUND" }, 404);
  });

  app.post("/multi-object-increments", async (context) => {
    const requestContext = context.get("requestContext");
    const input = await readJsonObject(context.req.raw);
    const increments = requireDemoObjectIncrements(input["increments"]);
    const snapshots: unknown[] = [];
    for (const increment of increments) {
      const object = requestContext.runtime.objects.SHOWCASE.get(increment.name);
      await object.increment(increment.delta, "multi-object-output-gate");
      snapshots.push(await object.read());
    }
    return context.json({
      outputGate: "one external boundary, one independent durability proof per object log",
      snapshots,
    });
  });

  app.get("/objects/:name", async (context) => {
    const requestContext = context.get("requestContext");
    const name = requireDemoObjectName(context.req.param("name"));
    const object = requestContext.runtime.objects.SHOWCASE.get(name);
    const snapshot = await object.read();
    return context.json(snapshot);
  });
  app.post("/objects/:name/increments", async (context) => {
    const requestContext = context.get("requestContext");
    const name = requireDemoObjectName(context.req.param("name"));
    const input = await readJsonObject(context.req.raw);
    const deltas = requireNumberArray(input["deltas"], "deltas");
    const label = requireString(input["label"], "label");
    const object = requestContext.runtime.objects.SHOWCASE.get(name);
    const intermediateCounts: number[] = [];
    for (const delta of deltas) {
      intermediateCounts.push(await object.increment(delta, label));
    }
    const result = { intermediateCounts, snapshot: await object.read() };
    return context.json({ outputGate: "one external durability boundary", ...result });
  });
  app.post("/objects/:name/compatibility-value", async (context) => {
    const requestContext = context.get("requestContext");
    const name = requireDemoObjectName(context.req.param("name"));
    const input = await readJsonObject(context.req.raw);
    const value = requireString(input["value"], "value");
    const object = requestContext.runtime.objects.SHOWCASE.get(name);
    const snapshot = await object.writeCompatibilityValue(value);
    return context.json(snapshot);
  });
  app.post("/objects/:name/alarm", async (context) => {
    const requestContext = context.get("requestContext");
    const name = requireDemoObjectName(context.req.param("name"));
    const input = await readJsonObject(context.req.raw);
    const delayMs = requireNonNegativeInteger(input["delayMs"], "delayMs");
    const object = requestContext.runtime.objects.SHOWCASE.get(name);
    const result = await object.scheduleAlarm(delayMs);
    return context.json(result, 202);
  });
  app.post("/objects/:name/background", async (context) => {
    const requestContext = context.get("requestContext");
    const name = requireDemoObjectName(context.req.param("name"));
    const input = await readJsonObject(context.req.raw);
    const note = requireString(input["note"], "note");
    const object = requestContext.runtime.objects.SHOWCASE.get(name);
    await object.startBackgroundNote(note);
    await requestContext.runtime.drainWaitUntil();
    const result = await object.read();
    return context.json(result, 202);
  });
  app.post("/objects/:name/callback", async (context) => {
    const requestContext = context.get("requestContext");
    const name = requireDemoObjectName(context.req.param("name"));
    const object = requestContext.runtime.objects.SHOWCASE.get(name);
    const result = await object.callback(async (message) => `main thread received: ${message}`);
    return context.json({ result });
  });
  app.post("/objects/:name/capability", async (context) => {
    const requestContext = context.get("requestContext");
    const name = requireDemoObjectName(context.req.param("name"));
    const input = await readJsonObject(context.req.raw);
    const deltas = requireNumberArray(input["deltas"], "deltas");
    const object = requestContext.runtime.objects.SHOWCASE.get(name);
    const capability = object.operationCapability();
    const counts: number[] = [];
    try {
      for (const delta of deltas) {
        counts.push(await capability.increment(delta));
      }
    } finally {
      capability[Symbol.dispose]();
    }
    return context.json({ promisePipelinedCapabilityCounts: counts });
  });
  app.post("/objects/:name/values", async (context) => {
    const requestContext = context.get("requestContext");
    const name = requireDemoObjectName(context.req.param("name"));
    const original = {
      label: "created on main thread",
      createdAt: new Date(),
      bytes: new Uint8Array([1, 2, 3]),
      total: 9_007_199_254_740_993n,
    };
    const object = requestContext.runtime.objects.SHOWCASE.get(name);
    const returned = await object.exchangeValues(original);
    return context.json({
      originalAfterRpc: serializeDemoRpcValues(original),
      returnedFromWorker: serializeDemoRpcValues(returned),
    });
  });
  app.all("/objects/:name/fetch", forwardDemoObjectFetch);
  app.all("/objects/:name/fetch/*", forwardDemoObjectFetch);

  return app;
}

async function forwardDemoObjectFetch(context: Context<NodeHonoEnvironment>): Promise<Response> {
  const requestContext = context.get("requestContext");
  const name = requireDemoObjectName(context.req.param("name"));
  const sourceUrl = new URL(context.req.url);
  const fetchPathPrefix = `/objects/${encodeURIComponent(name)}/fetch`;
  const targetPath = sourceUrl.pathname.slice(fetchPathPrefix.length) || "/";
  const targetUrl = new URL(targetPath, "https://demo.object");
  targetUrl.search = sourceUrl.search;
  const request = context.req.raw;
  const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
  const objectRequest = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body,
    duplex: body ? "half" : undefined,
  } as RequestInit);
  const object = requestContext.runtime.objects.SHOWCASE.get(name);
  return await object.fetch(objectRequest);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const value = (await request.json()) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NodeRequestInputError("DEMO_JSON_OBJECT_REQUIRED");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new NodeRequestInputError(`DEMO_STRING_INVALID:${field}`);
  }
  return value;
}

function requireNumberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new NodeRequestInputError(`DEMO_NUMBER_ARRAY_INVALID:${field}`);
  }
  const entries = value as unknown[];
  if (
    entries.length === 0 ||
    entries.some((entry) => typeof entry !== "number" || !Number.isSafeInteger(entry))
  ) {
    throw new NodeRequestInputError(`DEMO_NUMBER_ARRAY_INVALID:${field}`);
  }
  return entries as number[];
}

function requireDemoObjectIncrements(value: unknown): { name: string; delta: number }[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new NodeRequestInputError("DEMO_MULTI_OBJECT_INCREMENTS_INVALID");
  }
  return (value as unknown[]).map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new NodeRequestInputError(`DEMO_MULTI_OBJECT_INCREMENT_INVALID:${index}`);
    }
    const record = entry as Record<string, unknown>;
    const name = requireDemoObjectName(
      typeof record["name"] === "string" ? record["name"] : undefined,
    );
    const delta = record["delta"];
    if (typeof delta !== "number" || !Number.isSafeInteger(delta)) {
      throw new NodeRequestInputError(`DEMO_MULTI_OBJECT_DELTA_INVALID:${index}`);
    }
    return { name, delta };
  });
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new NodeRequestInputError(`DEMO_NON_NEGATIVE_INTEGER_INVALID:${field}`);
  }
  return value;
}

function serializeDemoRpcValues(value: {
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
