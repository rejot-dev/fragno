import { afterAll, assert, beforeAll, expect, test } from "vitest";

import { randomUUID } from "node:crypto";
import { createServer, request as requestNodeHttp, type Server } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { GraftControlStore } from "@fragno-private/backoffice-node-runtime/graft-control-store";
import { startGraftGatewayDirectory } from "@fragno-private/backoffice-node-runtime/graft-gateway-directory";
import type { GraftNodeRuntimeStorage } from "@fragno-private/backoffice-node-runtime/graft-runtime-storage";
import {
  startAuthorityBoundGraftNodeObjectHost,
  type NodeObjectRuntimeHostApplication,
} from "@fragno-private/backoffice-node-runtime/node-object-runtime-host";
import { createNodeRuntimeGateway } from "@fragno-private/backoffice-node-runtime/node-runtime-gateway";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import { createNodeRuntimeScenarioEnvironment } from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import { createAdaptorServer } from "@hono/node-server";

import type { createGraftCounterObject } from "../testing/fixtures/graft-runtime.objects";

const counter = defineNodeRuntimeObject<typeof createGraftCounterObject>(
  new URL("../testing/fixtures/graft-runtime.objects.ts", import.meta.url),
  "createGraftCounterObject",
);

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

test("a discovered runtime host receives application credentials and streams without demo health routes", async () => {
  const storage = environment.createStorage();
  const deliveredPaths: string[] = [];
  const host = await startGatewayScenarioHost(storage, {
    async fetch(request) {
      const url = new URL(request.url);
      deliveredPaths.push(url.pathname);
      if (url.pathname === "/application/redirect") {
        return new Response(null, { status: 307, headers: { location: "/application/target" } });
      }
      return Response.json(
        {
          method: request.method,
          path: url.pathname,
          search: url.search,
          authorization: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
          proxyAuthorization: request.headers.get("proxy-authorization"),
          hopHeader: request.headers.get("x-hop-only"),
          body: await request.text(),
        },
        {
          status: 201,
          headers: [
            ["set-cookie", "one=1; HttpOnly"],
            ["set-cookie", "two=2; HttpOnly"],
          ],
        },
      );
    },
    handleFetchFailure(error) {
      throw error;
    },
  });
  const gateway = createNodeRuntimeGateway({
    directory: startGraftGatewayDirectory(storage),
  });
  const server = createAdaptorServer({ fetch: gateway.fetch }) as Server;
  try {
    const origin = await listenGatewayScenarioServer(server);
    await expect
      .poll(async () => (await gateway.fetch(new Request(`${origin}/_runtime/ready`))).status)
      .toBe(200);
    const delivered = await new Promise<{ status: number; body: string; cookies: string[] }>(
      (resolve, reject) => {
        const request = requestNodeHttp(
          `${origin}/application/echo?scope=one`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer application-token",
              cookie: "session=application-session",
              "proxy-authorization": "Basic proxy-token",
              connection: "keep-alive, x-hop-only",
              "x-hop-only": "private-to-this-hop",
            },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              body += chunk;
            });
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                body,
                cookies: response.headers["set-cookie"] ?? [],
              }),
            );
          },
        );
        request.on("error", reject);
        request.write("streamed ");
        request.end("body");
      },
    );
    assert.equal(delivered.status, 201);
    expect(JSON.parse(delivered.body)).toEqual({
      method: "POST",
      path: "/application/echo",
      search: "?scope=one",
      authorization: "Bearer application-token",
      cookie: "session=application-session",
      proxyAuthorization: null,
      hopHeader: null,
      body: "streamed body",
    });
    expect(delivered.cookies).toEqual(["one=1; HttpOnly", "two=2; HttpOnly"]);
    const redirect = await fetch(`${origin}/application/redirect`, { redirect: "manual" });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), "/application/target");
    await redirect.body?.cancel();
    // These names carry no gateway policy: only the application decides which routes exist.
    for (const pathname of ["/health", "/control", "/debug", "/new-application-route"]) {
      const applicationResponse = await fetch(`${origin}${pathname}`);
      assert.equal(applicationResponse.status, 201);
      await applicationResponse.body?.cancel();
    }
    for (const pathname of ["/_runtime/private", "/application/../_runtime/private"]) {
      const denied = await fetch(`${origin}${pathname}`);
      assert.equal(denied.status, 404);
      await denied.body?.cancel();
    }
    expect(deliveredPaths).toEqual([
      "/application/echo",
      "/application/redirect",
      "/health",
      "/control",
      "/debug",
      "/new-application-route",
    ]);
  } finally {
    await gateway.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await host.close({ maximumDrainDurationMs: 2_000 });
  }
});

test.each(["nodeId", "processGeneration"] as const)(
  "readiness rejects an address reused by a different %s",
  async (field) => {
    const host = await startGatewayScenarioHost(environment.createStorage(), {
      fetch() {
        throw new Error("GATEWAY_SCENARIO_WRONG_INCARNATION_DELIVERED");
      },
      handleFetchFailure(error) {
        throw error;
      },
    });
    const storage = environment.createStorage();
    const store = new GraftControlStore(storage);
    const directory = startGraftGatewayDirectory(storage);
    const gateway = createNodeRuntimeGateway({ directory });
    try {
      store.registerNode({
        commandId: randomUUID(),
        commandCreatedAtMs: Date.now(),
        input: {
          lease: {
            ...host.nodeIdentity,
            [field]: randomUUID(),
            renewalId: randomUUID(),
            expiresAtMs: Date.now() + 60_000,
          },
        },
      });
      await expect.poll(() => directory.readLiveWorkers().length).toBe(1);
      const response = await gateway.fetch(new Request("http://gateway/application"));
      assert.equal(response.status, 503);
      expect(await response.json()).toEqual({ error: "NODE_RUNTIME_GATEWAY_NO_READY_WORKER" });
    } finally {
      await gateway.close();
      store.close();
      await host.close({ maximumDrainDurationMs: 2_000 });
    }
  },
);

test("gateway close cancels response streams and rejects reserved runtime routes and upgrades", async () => {
  const storage = environment.createStorage();
  const streamCancelled = Promise.withResolvers<void>();
  let applicationRequests = 0;
  const host = await startGatewayScenarioHost(storage, {
    fetch() {
      applicationRequests++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first chunk"));
          },
          cancel() {
            streamCancelled.resolve();
          },
        }),
      );
    },
    handleFetchFailure(error) {
      throw error;
    },
  });
  const directory = startGraftGatewayDirectory(storage);
  const gateway = createNodeRuntimeGateway({ directory });
  try {
    await expect.poll(() => directory.readLiveWorkers().length).toBe(1);
    for (const request of [
      new Request("http://gateway/_runtime/private"),
      new Request("http://gateway/_runtime/ready", { method: "POST" }),
      new Request("http://gateway/application", { headers: { upgrade: "websocket" } }),
    ]) {
      assert.equal((await gateway.fetch(request)).status, 404);
    }
    expect(applicationRequests).toBe(0);
    const response = await gateway.fetch(new Request("http://gateway/application/stream"));
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first chunk");
    const nextChunk = reader.read();
    const rejectedChunk = expect(nextChunk).rejects.toThrow();
    await Promise.all([gateway.close(), gateway.close()]);
    await rejectedChunk;
    await streamCancelled.promise;
    expect(directory.readLiveWorkers()).toEqual([]);
    assert.equal((await gateway.fetch(new Request("http://gateway/application"))).status, 503);
    expect(applicationRequests).toBe(1);
  } finally {
    await gateway.close();
    await host.close({ maximumDrainDurationMs: 2_000 });
  }
});

test("a durably committed mutation with a lost HTTP acknowledgement is never replayed", async () => {
  let mutationsDelivered = 0;
  const host = await startGatewayScenarioHost(environment.createStorage(), {
    async fetch(request) {
      using object = host.runtime.objects.COUNTER.get("uncertain");
      if (request.method === "POST") {
        mutationsDelivered++;
        await object.increment(1);
      }
      return Response.json(await object.read());
    },
    handleFetchFailure(error) {
      throw error;
    },
  });
  const faultProxy = createServer((request, response) => {
    void (async () => {
      const upstream = await fetch(new URL(request.url ?? "/", host.applicationOrigin), {
        method: request.method,
      });
      if (request.method === "POST") {
        assert.equal(upstream.status, 200);
        await upstream.text();
        // The runtime output gate has pushed the SQLite mutation; only its acknowledgement is lost.
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (upstream.body) {
        Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>).pipe(response);
      } else {
        response.end();
      }
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  const storage = environment.createStorage();
  const store = new GraftControlStore(storage);
  const directory = startGraftGatewayDirectory(storage);
  const gateway = createNodeRuntimeGateway({ directory });
  try {
    const proxyOrigin = await listenGatewayScenarioServer(faultProxy);
    store.registerNode({
      commandId: randomUUID(),
      commandCreatedAtMs: Date.now(),
      input: {
        lease: {
          ...host.nodeIdentity,
          applicationOrigin: proxyOrigin,
          expiresAtMs: Date.now() + 60_000,
          renewalId: randomUUID(),
        },
      },
    });
    await expect.poll(() => directory.readLiveWorkers().length).toBe(1);
    const response = await gateway.fetch(
      new Request("http://gateway/application/increment", { method: "POST" }),
    );
    assert.equal(response.status, 503);
    expect(await response.json()).toEqual({ error: "NODE_RUNTIME_GATEWAY_DELIVERY_UNCERTAIN" });
    const persisted = await fetch(`${host.applicationOrigin}/application/count`);
    expect(await persisted.json()).toMatchObject({ count: 1 });
    expect(mutationsDelivered).toBe(1);
  } finally {
    await gateway.close();
    faultProxy.closeAllConnections();
    await new Promise<void>((resolve) => faultProxy.close(() => resolve()));
    store.close();
    await host.close({ maximumDrainDurationMs: 2_000 });
  }
});

async function listenGatewayScenarioServer(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("GATEWAY_SCENARIO_LISTENER_ADDRESS_MISSING");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startGatewayScenarioHost(
  storage: GraftNodeRuntimeStorage,
  application: NodeObjectRuntimeHostApplication,
) {
  return await startAuthorityBoundGraftNodeObjectHost({
    storage,
    objects: { COUNTER: counter },
    clock: { kind: "system" },
    identity: { kind: "generated", compatibilityVersion: 1 },
    leasePolicy: {
      leaseDurationMs: 10_000,
      renewalIntervalMs: 2_000,
      renewalRetryIntervalMs: 250,
      selfFenceSafetyMarginMs: 1_000,
      maximumClockSkewMs: 100,
    },
    peerRpc: {
      authenticationSecret: "gateway-runtime-scenario-peer-secret",
      authenticationWindowMs: 5_000,
    },
    objectProvisioning: { kind: "lazy" },
    objectEviction: { kind: "disabled" },
    network: {
      application: {
        listenHost: "127.0.0.1",
        listenPort: 0,
        resolveOrigin(port) {
          return `http://127.0.0.1:${port}`;
        },
      },
      internal: {
        listenHost: "127.0.0.1",
        listenPort: 0,
        peerWebSocketPath: "/application/peer",
        peerWebSocketMaximumPayloadBytes: 1_024,
        resolveOrigin(port) {
          return `http://127.0.0.1:${port}`;
        },
      },
    },
    alarmPolling: { kind: "manual" },
    createApplications() {
      return {
        application,
        internal: {
          fetch() {
            return new Response(null, { status: 404 });
          },
          handleFetchFailure(error) {
            throw error;
          },
        },
      };
    },
  });
}
