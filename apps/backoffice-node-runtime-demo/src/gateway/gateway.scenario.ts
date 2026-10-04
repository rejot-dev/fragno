import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as requestNodeHttp, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { startGraftGatewayDirectory } from "@fragno-private/backoffice-node-runtime/graft-gateway-directory";
import type { GraftNodeRuntimeStorage } from "@fragno-private/backoffice-node-runtime/graft-runtime-storage";
import {
  createNodeRuntimeGateway,
  type NodeRuntimeGatewayDirectory,
} from "@fragno-private/backoffice-node-runtime/node-runtime-gateway";

import { createAdaptorServer } from "@hono/node-server";

import { openFilesystemGraftStorage } from "../fleet/local-filesystem-graft-storage";
import { DemoNodeProcess } from "../fleet/node-process";

const root = await mkdtemp(path.join(os.tmpdir(), "demo-gateway-"));
const nodes: DemoNodeProcess[] = [];
let server: Server | null = null;
let gateway: ReturnType<typeof createNodeRuntimeGateway> | null = null;
try {
  const bootstrap = spawnSync(
    process.execPath,
    [
      new URL("../testing/fixtures/provision-filesystem-graft-storage-process.js", import.meta.url)
        .pathname,
      root,
    ],
    { encoding: "utf8" },
  );
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  for (const slot of ["red", "green"]) {
    nodes.push(
      await DemoNodeProcess.start({
        environment: process.env,
        slot,
        dataDirectory: root,
        cacheDirectory: path.join(root, "cache", slot),
        peerAuthenticationSecret: "gateway-scenario-authentication-secret",
        alarmIntervalMs: 60_000,
        leaseDurationMs: 10_000,
      }),
    );
  }
  const red = nodes[0];
  const green = nodes[1];
  const mutation = await fetch(`${red.applicationOrigin}/objects/gateway-overlap/increments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deltas: [5], label: "old-slot-owner" }),
  });
  assert.equal(mutation.status, 200);
  await mutation.body?.cancel();
  const storage = await openFilesystemGraftStorage(root, path.join(root, "cache", "gateway"));
  const liveDirectory = startGraftGatewayDirectory(storage);
  const greenDirectory: NodeRuntimeGatewayDirectory = {
    readLiveWorkers() {
      return liveDirectory.readLiveWorkers().filter((worker) => worker.nodeId === green.nodeId);
    },
    close() {
      return liveDirectory.close();
    },
  };
  const app = createNodeRuntimeGateway({
    directory: greenDirectory,
  });
  gateway = app;
  server = createAdaptorServer({
    fetch(request) {
      return app.fetch(request);
    },
  }) as Server;
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  const origin = `http://127.0.0.1:${bound.port}`;
  await waitForReady(origin);
  const response = await fetch(`${origin}/objects/gateway-overlap`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-node-runtime-ingress-node-id"), green.nodeId);
  assert.equal(((await response.json()) as { count: number }).count, 5);
  const stream = await fetch(`${origin}/objects/gateway-overlap/fetch/stream`);
  assert.equal(stream.status, 202);
  assert.ok((await stream.text()).length > 0);
  for (const route of [
    "/__node-object-peer",
    "/debug/overview",
    "/tick",
    "/control/gateway-overlap",
    "/api/fleet",
    "/objects/gateway-overlap/fetch/../../../__node-object-peer",
  ]) {
    const denied = await fetch(new URL(route, origin));
    assert.equal(denied.status, 404, route);
    await denied.body?.cancel();
  }
  // Isolation is enforced by node listener composition, not by the gateway's knowledge of routes.
  for (const [route, method] of [
    ["/", "GET"],
    ["/health", "GET"],
    ["/debug/overview", "GET"],
    ["/control/gateway-overlap", "GET"],
    ["/tick", "POST"],
  ]) {
    for (const applicationOrigin of [red.applicationOrigin, origin]) {
      const denied = await fetch(new URL(route, applicationOrigin), { method });
      assert.equal(denied.status, 404);
      await denied.body?.cancel();
    }
    const internal = await fetch(new URL(route, red.internalOrigin), { method });
    assert.equal(internal.status, 200);
    await internal.body?.cancel();
  }
  const internalApplication = await fetch(`${red.internalOrigin}/objects/gateway-overlap`);
  assert.equal(internalApplication.status, 404);
  await internalApplication.body?.cancel();
  await exerciseGatewayDeliveryFaults(red, storage);
  await green.stop(10_000);
  nodes.pop();
  const unavailable = await fetch(`${origin}/_runtime/ready`);
  assert.equal(unavailable.status, 503);
  await unavailable.body?.cancel();
  // The old-slot owner remains live, but must not become direct ingress on green failure.
  assert.equal((await fetch(`${red.applicationOrigin}/_runtime/ready`)).status, 200);
  console.log(
    "DEMO_GATEWAY_SCENARIO_PASSED: read-only discovery, green ingress to red owner, streams, route isolation, and unavailable-worker failure",
  );
} finally {
  server?.closeAllConnections();
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => {
        resolve();
      });
    });
  }
  await gateway?.close();
  await Promise.all(nodes.map((node) => node.stop(10_000)));
  await rm(root, { recursive: true, force: true });
}

async function exerciseGatewayDeliveryFaults(
  red: DemoNodeProcess,
  storage: GraftNodeRuntimeStorage,
): Promise<void> {
  let mutationsDelivered = 0;
  let streamBytesWritten = 0;
  const streamClosed = Promise.withResolvers<void>();
  const totalStreamBytes = 64 * 1_048_576;
  const faultProxy = createServer((request, response) => {
    void forwardFaultProxyRequest().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    async function forwardFaultProxyRequest(): Promise<void> {
      if (request.url === "/objects/gateway-cancel/fetch/stream") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.once("close", () => {
          streamClosed.resolve();
        });
        function writeUntilBackpressure(): void {
          while (!response.destroyed && streamBytesWritten < totalStreamBytes) {
            streamBytesWritten += 65_536;
            if (!response.write(Buffer.alloc(65_536))) {
              return;
            }
          }
          if (!response.destroyed) {
            response.end();
          }
        }
        response.on("drain", writeUntilBackpressure);
        writeUntilBackpressure();
        return;
      }
      try {
        if (request.url === "/objects/gateway-uncertain/increments") {
          assert.equal(request.headers.authorization, "Bearer application-credential");
          assert.equal(request.headers.cookie, "session=application-session");
          assert.equal(request.headers["proxy-authorization"], undefined);
          assert.equal(request.headers["x-drop-hop-header"], undefined);
        }
        const body =
          request.method === "GET" || request.method === "HEAD" ? null : Readable.toWeb(request);
        const upstream = await fetch(new URL(request.url ?? "/", red.applicationOrigin), {
          method: request.method,
          body,
          headers: { "content-type": "application/json" },
          ...(body === null ? {} : { duplex: "half" }),
        } as RequestInit);
        if (request.url === "/objects/gateway-uncertain/increments") {
          assert.equal(upstream.status, 200);
          await upstream.text();
          mutationsDelivered++;
          // The real object has committed durably; drop its HTTP acknowledgement on the wire.
          response.destroy();
          return;
        }
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        if (upstream.body) {
          Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>).pipe(response);
        } else {
          response.end();
        }
      } catch (error) {
        console.error("DEMO_GATEWAY_FAULT_PROXY_FAILED", error);
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  await new Promise<void>((resolve) => {
    faultProxy.listen(0, "127.0.0.1", resolve);
  });
  const address = faultProxy.address();
  assert.ok(address && typeof address !== "string");
  const faultOrigin = new URL(`http://127.0.0.1:${address.port}`);
  const directory = startGraftGatewayDirectory(storage);
  const faultDirectory: NodeRuntimeGatewayDirectory = {
    readLiveWorkers() {
      return directory
        .readLiveWorkers()
        .filter((worker) => worker.nodeId === red.nodeId)
        .map((worker) => ({ ...worker, applicationOrigin: faultOrigin.origin }));
    },
    close() {
      return directory.close();
    },
  };
  const app = createNodeRuntimeGateway({
    directory: faultDirectory,
  });
  const streamGateway = createAdaptorServer({
    fetch(request) {
      return app.fetch(request);
    },
  }) as Server;
  await new Promise<void>((resolve) => {
    streamGateway.listen(0, "127.0.0.1", resolve);
  });
  const gatewayAddress = streamGateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress !== "string");
  const gatewayOrigin = `http://127.0.0.1:${gatewayAddress.port}`;
  try {
    await waitForReady(gatewayOrigin);
    // Node fetch replaces Connection itself, so use raw HTTP to exercise nominated hop headers.
    const failedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const delivery = requestNodeHttp(
        `${gatewayOrigin}/objects/gateway-uncertain/increments`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer application-credential",
            cookie: "session=application-session",
            "proxy-authorization": "Basic proxy-only-credential",
            connection: "keep-alive, x-drop-hop-header",
            "x-drop-hop-header": "must-not-reach-worker",
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => {
            resolve(response.statusCode);
          });
        },
      );
      delivery.once("error", reject);
      delivery.end(JSON.stringify({ deltas: [4], label: "uncertain-delivery" }));
    });
    assert.equal(failedStatus, 503);
    assert.equal(mutationsDelivered, 1);
    const persisted = await fetch(`${red.applicationOrigin}/objects/gateway-uncertain`);
    assert.equal(((await persisted.json()) as { count: number }).count, 4);
    const cancellation = new AbortController();
    const streamed = await fetch(`${gatewayOrigin}/objects/gateway-cancel/fetch/stream`, {
      signal: cancellation.signal,
    });
    assert.equal(streamed.status, 200);
    const reader = streamed.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });
    assert.ok(
      streamBytesWritten < totalStreamBytes,
      "gateway buffered the entire upstream instead of applying backpressure",
    );
    cancellation.abort();
    await reader.cancel().catch((error: unknown) => {
      assert.ok(error instanceof Error);
    });
    await Promise.race([
      streamClosed.promise,
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("DEMO_GATEWAY_CANCELLATION_NOT_PROPAGATED"));
        }, 2_000);
        timeout.unref();
      }),
    ]);
  } finally {
    await app.close();
    streamGateway.closeAllConnections();
    faultProxy.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => {
        streamGateway.close(() => {
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        faultProxy.close(() => {
          resolve();
        });
      }),
    ]);
  }
}

async function waitForReady(origin: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/_runtime/ready`);
    await response.body?.cancel();
    if (response.ok) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error("DEMO_GATEWAY_SCENARIO_READINESS_TIMEOUT");
}
