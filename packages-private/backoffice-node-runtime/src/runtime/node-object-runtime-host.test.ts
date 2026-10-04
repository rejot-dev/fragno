import { afterAll, assert, beforeAll, expect, test } from "vitest";

import { createServer, type Server } from "node:http";

import { WebSocket } from "ws";

import { GraftWorkerDirectory } from "../graft/graft-worker-directory";
import { createNodeRuntimeScenarioEnvironment } from "../testing/node-runtime-scenario";
import {
  startAuthorityBoundGraftNodeObjectHost,
  type AuthorityBoundGraftNodeObjectHostOptions,
  type NodeObjectRuntimeHostApplication,
} from "./node-object-runtime-host";
import { createManualNodeRuntimeClock, type NodeRuntimeClock } from "./node-runtime-clock";
import { nodeRuntimeReadinessPath } from "./node-runtime-readiness";

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

test("separate listeners publish application readiness and isolate HTTP handlers and peer upgrades", async () => {
  const options = createTestHostOptions({
    fetch(request) {
      return new URL(request.url).pathname === "/application"
        ? new Response("application")
        : new Response(null, { status: 404 });
    },
    handleFetchFailure(error) {
      return new Response(String(error), { status: 500 });
    },
  });
  const host = await startAuthorityBoundGraftNodeObjectHost(options);
  const directory = new GraftWorkerDirectory(options.storage);
  try {
    const readiness = await fetch(`${host.applicationOrigin}${nodeRuntimeReadinessPath}`);
    assert.equal(readiness.status, 200);
    assert.equal(readiness.headers.get("cache-control"), "no-store");
    expect(await readiness.json()).toEqual({
      status: "ready",
      nodeId: host.nodeIdentity.nodeId,
      processGeneration: host.nodeIdentity.processGeneration,
    });
    expect(directory.readLiveWorkers(Date.now())).toMatchObject([
      {
        applicationOrigin: host.applicationOrigin,
        privateAddress: host.peerWebSocketAddress,
      },
    ]);
    assert.equal((await fetch(`${host.applicationOrigin}/application`)).status, 200);
    assert.equal((await fetch(`${host.internalOrigin}/internal`)).status, 200);
    for (const [origin, pathname] of [
      [host.applicationOrigin, "/internal"],
      [host.applicationOrigin, "/node-object-peer"],
      [host.internalOrigin, "/application"],
      [host.internalOrigin, nodeRuntimeReadinessPath],
    ]) {
      assert.equal((await fetch(`${origin}${pathname}`)).status, 404);
    }
    const rejectedPeer = new WebSocket(
      `${host.applicationOrigin.replace("http:", "ws:")}/node-object-peer`,
    );
    await new Promise<void>((resolve, reject) => {
      rejectedPeer.on("error", reject);
      rejectedPeer.on("unexpected-response", (_request, response) => {
        assert.equal(response.statusCode, 404);
        response.resume();
        // ws leaves the handshake pending when unexpected-response is handled by the caller.
        rejectedPeer.removeListener("error", reject);
        rejectedPeer.on("error", () => undefined);
        rejectedPeer.terminate();
        resolve();
      });
    });
    const internalPeer = new WebSocket(host.peerWebSocketAddress);
    await new Promise<void>((resolve, reject) => {
      internalPeer.once("error", reject);
      internalPeer.once("open", () => {
        internalPeer.close();
        resolve();
      });
    });
  } finally {
    directory.close();
    await host.close({ maximumDrainDurationMs: 2_000 });
  }
  await expect(fetch(`${host.applicationOrigin}/application`)).rejects.toThrow();
  await expect(fetch(`${host.internalOrigin}/internal`)).rejects.toThrow();
});

test.each(["application", "readiness"] as const)(
  "self-fencing rejects application admission but leaves internal inspection available (%s first)",
  async (firstCheck) => {
    const clock = createManualNodeRuntimeClock(1_000);
    const host = await startAuthorityBoundGraftNodeObjectHost(
      createTestHostOptions(
        {
          fetch() {
            return new Response("application");
          },
          handleFetchFailure(error) {
            return new Response(String(error), { status: 503 });
          },
        },
        clock.source,
      ),
    );
    try {
      assert.equal((await fetch(host.applicationOrigin)).status, 200);
      clock.advanceMonotonicBy(10_000);
      if (firstCheck === "application") {
        assert.equal((await fetch(host.applicationOrigin)).status, 503);
      }
      const readiness = await fetch(`${host.applicationOrigin}${nodeRuntimeReadinessPath}`);
      assert.equal(readiness.status, 503);
      assert.equal(readiness.headers.get("cache-control"), "no-store");
      expect(await readiness.json()).toEqual({ status: "not-ready" });
      assert.equal((await fetch(host.applicationOrigin)).status, 503);
      const diagnostics = await fetch(`${host.internalOrigin}/internal`);
      assert.equal(diagnostics.status, 200);
      expect(await diagnostics.json()).toMatchObject({ state: "fenced" });
    } finally {
      await host.close({ maximumDrainDurationMs: 2_000 });
    }
  },
);

test.each(["application", "internal"] as const)(
  "bounded close drains admitted %s work and closes both listeners",
  async (surface) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocking: NodeObjectRuntimeHostApplication = {
      async fetch() {
        started.resolve();
        await release.promise;
        return new Response("finished");
      },
      handleFetchFailure(error) {
        return new Response(String(error), { status: 500 });
      },
    };
    const options = createTestHostOptions(blocking);
    const host = await startAuthorityBoundGraftNodeObjectHost({
      ...options,
      createApplications(context) {
        const applications = options.createApplications(context);
        return { ...applications, [surface]: blocking };
      },
    });
    const request = fetch(
      `${surface === "application" ? host.applicationOrigin : host.internalOrigin}/blocked`,
    );
    await started.promise;
    try {
      await expect(host.close({ maximumDrainDurationMs: 50 })).rejects.toThrow(
        "NODE_OBJECT_RUNTIME_HOST_CLOSE_DEADLINE_EXCEEDED:50",
      );
    } finally {
      release.resolve();
    }
    assert.equal(await (await request).text(), "finished");
    await host.close({ maximumDrainDurationMs: 2_000 });
    assert.equal(host.runtime.readNodeAuthorityStatus().state, "closed");
    await expect(fetch(host.applicationOrigin)).rejects.toThrow();
    await expect(fetch(host.internalOrigin)).rejects.toThrow();
  },
);

test.each(["application", "internal"] as const)(
  "a failed %s bind leaves neither listener nor registered authority behind",
  async (surface) => {
    const occupied = createServer();
    const unused = createServer();
    const occupiedPort = await bindTestServer(occupied, 0);
    const unusedPort = await bindTestServer(unused, 0);
    await closeTestServer(unused);
    const options = createTestHostOptions({
      fetch() {
        return new Response("application");
      },
      handleFetchFailure(error) {
        throw error;
      },
    });
    options.network.application.listenPort = surface === "application" ? occupiedPort : unusedPort;
    options.network.internal.listenPort = surface === "internal" ? occupiedPort : unusedPort;
    const directory = new GraftWorkerDirectory(options.storage);
    try {
      await expect(startAuthorityBoundGraftNodeObjectHost(options)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      await bindTestServer(unused, unusedPort);
      expect(directory.readLiveWorkers(Date.now())).toEqual([]);
    } finally {
      directory.close();
      await closeTestServer(occupied);
      if (unused.listening) {
        await closeTestServer(unused);
      }
    }
  },
);

test("failure after both listeners bind closes both servers and the runtime", async () => {
  const options = createTestHostOptions({
    fetch() {
      return new Response("unused");
    },
    handleFetchFailure(error) {
      throw error;
    },
  });
  let applicationOrigin = "";
  let internalOrigin = "";
  await expect(
    startAuthorityBoundGraftNodeObjectHost({
      ...options,
      createApplications(context) {
        applicationOrigin = context.applicationOrigin;
        internalOrigin = context.internalOrigin;
        throw new Error("HOST_SCENARIO_APPLICATION_START_FAILED");
      },
    }),
  ).rejects.toThrow("HOST_SCENARIO_APPLICATION_START_FAILED");
  for (const origin of [applicationOrigin, internalOrigin]) {
    const server = createServer();
    try {
      await bindTestServer(server, Number(new URL(origin).port));
    } finally {
      if (server.listening) {
        await closeTestServer(server);
      }
    }
  }
});

function createTestHostOptions(
  application: NodeObjectRuntimeHostApplication,
  clock: NodeRuntimeClock = { kind: "system" },
): AuthorityBoundGraftNodeObjectHostOptions<Record<string, never>> {
  return {
    storage: environment.createStorage(),
    objects: {},
    clock,
    identity: { kind: "generated", compatibilityVersion: 1 },
    leasePolicy: {
      leaseDurationMs: 10_000,
      renewalIntervalMs: 2_000,
      renewalRetryIntervalMs: 250,
      selfFenceSafetyMarginMs: 1_000,
      maximumClockSkewMs: 100,
    },
    peerRpc: {
      authenticationSecret: "node-object-runtime-host-test-secret",
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
        peerWebSocketPath: "/node-object-peer",
        peerWebSocketMaximumPayloadBytes: 1_024,
        resolveOrigin(port) {
          return `http://127.0.0.1:${port}`;
        },
      },
    },
    alarmPolling: { kind: "manual" },
    createApplications({ runtime }) {
      return {
        application,
        internal: {
          fetch(request) {
            return new URL(request.url).pathname === "/internal"
              ? Response.json(runtime.readNodeAuthorityStatus())
              : new Response(null, { status: 404 });
          },
          handleFetchFailure(error) {
            return new Response(String(error), { status: 500 });
          },
        },
      };
    },
  };
}

async function bindTestServer(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HOST_SCENARIO_ADDRESS_MISSING");
  }
  return address.port;
}

async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
