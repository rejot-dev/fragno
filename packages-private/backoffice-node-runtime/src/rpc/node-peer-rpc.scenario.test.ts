import { afterAll, assert, beforeAll, expect, test } from "vitest";

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  GraftControlStore,
  type GraftNodeLease,
} from "@fragno-private/backoffice-node-runtime/graft-control-store";
import {
  createSqlitePragmaGraftDatabaseOperations,
  defineGraftDatabaseOperations,
} from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import { createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { NodePeerRpcNetwork } from "@fragno-private/backoffice-node-runtime/node-peer-rpc";
import { createManualNodeRuntimeClock } from "@fragno-private/backoffice-node-runtime/node-runtime-clock";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import { createNodeRuntimeScenarioEnvironment } from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";
import type { RpcStub } from "capnweb";

import { createNodePeerObjectRoute } from "../runtime/node-object-peer-routing";
import { ControlScenarioGraftOperations } from "../testing/fixtures/control-scenario-graft-operations";
import type { createValuesObject } from "../testing/fixtures/node-runtime-scenario.objects";
import { attachNodePeerWebSocketServer } from "./node-peer-websocket-server";

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

test("peer calls reuse confirmed authority and route snapshots reuse a clean control replica", async () => {
  const scenario = await createPeerScenario();
  try {
    using object = await scenario.getObject();
    const before = { ...scenario.operations.counts };
    assert((await object.callback(async () => "first")) === "first");
    assert((await object.callback(async () => "second")) === "second");
    using capability = await object.counter();
    assert((await capability.add(2)) === 2);
    assert((await capability.add(3)) === 5);
    expect(scenario.operations.counts).toEqual(before);

    using fresh = await scenario.getObject();
    assert((await fresh.callback(async () => "fresh")) === "fresh");
    expect(scenario.operations.counts).toEqual({ ...before, pulls: before.pulls + 1 });
    const response = await fresh.fetch(new Request("https://scenario.test/state"));
    expect(await response.json()).toMatchObject({ isMainThread: false });
    expect(scenario.operations.counts).toEqual({ ...before, pulls: before.pulls + 1 });
  } finally {
    await scenario.close();
  }
});

test.each(["none", "lose-response"] as const)(
  "a renewal with %s refreshes an expired peer window once, without recloning",
  async (pushFailure) => {
    const scenario = await createPeerScenario();
    try {
      using object = await scenario.getObject();
      assert((await object.callback(async () => "before renewal")) === "before renewal");
      const before = { ...scenario.operations.counts };
      scenario.clock.advanceBy(500);
      scenario.writerOperations.pushFailure = pushFailure;
      assert(scenario.renewCaller(3_000).outcome === "renewed");
      scenario.clock.advanceBy(500);
      assert((await object.callback(async () => "after renewal")) === "after renewal");
      assert((await object.callback(async () => "still live")) === "still live");
      expect(scenario.operations.counts).toEqual({ ...before, pulls: before.pulls + 1 });
    } finally {
      await scenario.close();
    }
  },
);

test.each(["expired", "renewed"] as const)(
  "a blocked peer call revalidates its %s caller before returning",
  async (outcome) => {
    const scenario = await createPeerScenario();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let settlement: Promise<unknown> = Promise.resolve();
    try {
      using object = await scenario.getObject();
      const pending = Promise.resolve(
        object.callback(async () => {
          entered.resolve();
          await release.promise;
          return "completed call";
        }),
      );
      settlement = pending.catch(() => {});
      await waitForPeerCallback(entered.promise, pending);
      scenario.clock.advanceBy(500);
      if (outcome === "renewed") {
        assert(scenario.renewCaller(3_000).outcome === "renewed");
      }
      scenario.clock.advanceBy(500);
      if (outcome === "expired") {
        const rejected = expect(pending).rejects.toThrow("NODE_PEER_RPC_CALLER_LEASE_EXPIRED");
        release.resolve();
        await rejected;
        await expect(object.callback(async () => "not admitted")).rejects.toThrow(
          "NODE_PEER_RPC_CALLER_LEASE_EXPIRED",
        );
      } else {
        release.resolve();
        assert((await pending) === "completed call");
      }
      assert(scenario.runtime.readNodeAuthorityStatus().state === "serving");
      using local = scenario.runtime.objects.VALUES.get("one");
      assert((await local.callback(async () => "owner live")) === "owner live");
    } finally {
      release.resolve();
      await settlement;
      await scenario.close();
    }
  },
  15_000,
);

test("a slow successful refresh does not gift time to the renewed monotonic deadline", async () => {
  const scenario = await createPeerScenario();
  try {
    using object = await scenario.getObject();
    scenario.clock.advanceBy(500);
    assert(scenario.renewCaller(3_000).outcome === "renewed");
    scenario.clock.advanceBy(500);
    scenario.operations.pullElapsedMs = 100;
    assert((await object.callback(async () => "renewed")) === "renewed");
    scenario.operations.pullElapsedMs = 0;
    scenario.clock.setEpochMilliseconds(1_500);
    scenario.clock.advanceMonotonicBy(900);
    await expect(object.callback(async () => "late output")).rejects.toThrow(
      "NODE_PEER_RPC_CALLER_LEASE_EXPIRED",
    );
  } finally {
    scenario.operations.pullElapsedMs = 0;
    await scenario.close();
  }
});

test("failed renewal and failed refresh never extend cached peer authority", async () => {
  const scenario = await createPeerScenario();
  try {
    using object = await scenario.getObject();
    scenario.clock.advanceBy(500);
    scenario.writerOperations.pushFailure = "before-push";
    expect(() => scenario.renewCaller(3_000)).toThrow("GRAFT_CONTROL_COMMAND_DURABILITY_UNCERTAIN");
    scenario.operations.pullFailure = "before-pull";
    assert((await object.callback(async () => "confirmed window")) === "confirmed window");
    scenario.clock.advanceBy(500);
    await expect(object.callback(async () => "unconfirmed")).rejects.toThrow(
      "EXPECTED_CONTROL_PULL_FAILURE",
    );
    scenario.operations.pullFailure = "none";
    await expect(object.callback(async () => "expired")).rejects.toThrow(
      "NODE_PEER_RPC_CALLER_LEASE_EXPIRED",
    );
  } finally {
    scenario.operations.pullFailure = "none";
    scenario.writerOperations.pushFailure = "none";
    await scenario.close();
  }
});

test.each(["monotonic-expiry", "observed-wall-advance"] as const)(
  "%s followed by wall rollback cannot revive the same peer lease",
  async (correction) => {
    const scenario = await createPeerScenario();
    try {
      using object = await scenario.getObject();
      if (correction === "monotonic-expiry") {
        scenario.clock.advanceMonotonicBy(1_000);
      } else {
        scenario.clock.setEpochMilliseconds(2_000);
        await expect(object.callback(async () => "expired")).rejects.toThrow(
          "NODE_PEER_RPC_CALLER_LEASE_EXPIRED",
        );
      }
      scenario.clock.setEpochMilliseconds(500);
      await expect(object.callback(async () => "rolled back")).rejects.toThrow(
        "NODE_PEER_RPC_CALLER_LEASE_EXPIRED",
      );
      await expect(object.callback(async () => "retried")).rejects.toThrow(
        "NODE_PEER_RPC_CALLER_LEASE_EXPIRED",
      );
      const reconnect = scenario.createClient(scenario.lease);
      await expect(reconnect.getRemoteObject(scenario.route)).rejects.toThrow(
        "NODE_PEER_RPC_CALLER_LEASE_EXPIRED",
      );
    } finally {
      await scenario.close();
    }
  },
);

test("a handshake cannot grant a peer lease that expired during its control read", async () => {
  const scenario = await createPeerScenario();
  try {
    scenario.operations.pullElapsedMs = 1_000;
    await expect(scenario.getObject()).rejects.toThrow("NODE_PEER_RPC_CALLER_LEASE_EXPIRED");
    scenario.operations.pullElapsedMs = 0;
    await expect(scenario.getObject()).rejects.toThrow("NODE_PEER_RPC_CALLER_LEASE_EXPIRED");
  } finally {
    scenario.operations.pullElapsedMs = 0;
    await scenario.close();
  }
});

test("peer authority subtracts declared skew and rejects confirmation that arrives too late", async () => {
  const scenario = await createPeerScenario(50);
  try {
    using object = await scenario.getObject();
    scenario.clock.advanceBy(949);
    assert((await object.callback(async () => "before cutoff")) === "before cutoff");
    scenario.clock.advanceBy(1);
    await expect(object.callback(async () => "at cutoff")).rejects.toThrow(
      "NODE_PEER_RPC_CALLER_LEASE_EXPIRED",
    );
    assert(scenario.renewCaller(3_000).outcome === "renewed");
    scenario.operations.pullElapsedMs = 1_000;
    await expect(object.callback(async () => "late read")).rejects.toThrow(
      "NODE_PEER_RPC_CALLER_LEASE_EXPIRED",
    );
    scenario.operations.pullElapsedMs = 0;
    await expect(object.callback(async () => "no time gifted")).rejects.toThrow(
      "NODE_PEER_RPC_CALLER_LEASE_EXPIRED",
    );
  } finally {
    scenario.operations.pullElapsedMs = 0;
    await scenario.close();
  }
});

test.each(["process-generation", "compatibility"] as const)(
  "a peer with the same node ID but a different %s cannot borrow confirmed authority",
  async (mismatch) => {
    const scenario = await createPeerScenario();
    try {
      using original = await scenario.getObject();
      assert((await original.callback(async () => "original")) === "original");
      const identity = { ...scenario.lease };
      if (mismatch === "process-generation") {
        identity.processGeneration = randomUUID();
      } else {
        identity.compatibilityVersion += 1;
      }
      const other = scenario.createClient(identity);
      await expect(other.getRemoteObject(scenario.route)).rejects.toThrow(
        "NODE_PEER_RPC_CALLER_IDENTITY_MISMATCH",
      );
      assert((await original.callback(async () => "still original")) === "still original");
    } finally {
      await scenario.close();
    }
  },
);

test("cached peer authority does not admit a stale object claim", async () => {
  const scenario = await createPeerScenario();
  try {
    using object = await scenario.getObject();
    assert((await object.callback(async () => "valid claim")) === "valid claim");
    await expect(
      scenario.client.getRemoteObject({
        ...scenario.route,
        expectedClaimId: randomUUID(),
      }),
    ).rejects.toThrow("NODE_PEER_RPC_STALE_ROUTE");
    using refreshed = await scenario.getObject();
    assert((await refreshed.callback(async () => "original claim")) === "original claim");
  } finally {
    await scenario.close();
  }
});

async function waitForPeerCallback(
  entered: Promise<void>,
  pending: Promise<string>,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("PEER_SCENARIO_CALLBACK_TIMED_OUT")), 5_000);
  });
  try {
    await Promise.race([entered, pending, deadline]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

async function createPeerScenario(maximumClockSkewMs = 0) {
  const storage = environment.createStorage();
  const clock = createManualNodeRuntimeClock(1_000);
  const operations = new ControlScenarioGraftOperations(clock);
  const writerOperations = new ControlScenarioGraftOperations(clock);
  const callerStore = new GraftControlStore(storage, writerOperations, 2);
  const clients: NodePeerRpcNetwork[] = [];
  const server = createServer((_request, response) => response.writeHead(404).end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const peerRpc = {
    authenticationSecret: "peer-control-read-scenario-authentication-secret",
    authenticationWindowMs: 5_000,
  };
  const runtime = createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations({
    storage,
    clock: clock.source,
    nodeIdentity: {
      nodeId: randomUUID(),
      processGeneration: randomUUID(),
      privateAddress: `ws://127.0.0.1:${address.port}/peer`,
      applicationOrigin: `http://127.0.0.1:${address.port}`,
      compatibilityVersion: 1,
    },
    leasePolicy: {
      leaseDurationMs: 10_000,
      renewalIntervalMs: 2_000,
      renewalRetryIntervalMs: 100,
      selfFenceSafetyMarginMs: 100,
      maximumClockSkewMs,
    },
    peerRpc,
    objectProvisioning: { kind: "lazy" },
    objectEviction: { kind: "disabled" },
    objects: {
      VALUES: defineNodeRuntimeObject<typeof createValuesObject>(
        new URL("../testing/fixtures/node-runtime-scenario.objects.ts", import.meta.url),
        "createValuesObject",
      ),
    },
    databaseOperations: {
      control: operations,
      provisioning: createSqlitePragmaGraftDatabaseOperations(),
      worker: defineGraftDatabaseOperations(
        new URL("../graft/graft-database-operations.ts", import.meta.url),
        "createSqlitePragmaGraftDatabaseOperations",
        null,
      ),
    },
  });
  const peerServer = attachNodePeerWebSocketServer({
    server,
    path: "/peer",
    maximumPayloadBytes: 1_048_576,
    acceptWebSocket(webSocket) {
      runtime.acceptNodePeerWebSocket(webSocket);
    },
  });
  const lease: GraftNodeLease = {
    nodeId: randomUUID(),
    processGeneration: randomUUID(),
    privateAddress: "ws://127.0.0.1:1/peer",
    applicationOrigin: "http://127.0.0.1:1",
    compatibilityVersion: 1,
    expiresAtMs: 2_000,
    renewalId: randomUUID(),
  };
  function createClient(identity: GraftNodeLease) {
    const network = new NodePeerRpcNetwork({
      controlStore: callerStore,
      maximumClockSkewMs,
      clock: clock.source,
      identity,
      config: peerRpc,
      provider: {
        async getLocalObjectForPeer() {
          throw new Error("PEER_SCENARIO_CALLER_HAS_NO_OBJECTS");
        },
      },
    });
    clients.push(network);
    return network;
  }
  async function close() {
    for (const network of clients) {
      network.close();
    }
    await peerServer.close();
    try {
      await runtime.cleanup();
    } finally {
      callerStore.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  try {
    callerStore.registerNode({
      commandId: randomUUID(),
      commandCreatedAtMs: 1_000,
      input: { lease },
    });
    using local = runtime.objects.VALUES.get("one");
    await local.callback(async () => "activated");
    const routing = callerStore.readObjectRoutingState("VALUES:one");
    assert(routing?.kind === "owned-with-node-lease");
    const route = createNodePeerObjectRoute("VALUES", "one", routing);
    const client = createClient(lease);
    return {
      clock,
      operations,
      writerOperations,
      runtime,
      lease,
      client,
      route,
      createClient,
      close,
      async getObject() {
        return (await client.getRemoteObject(route)) as unknown as RpcStub<
          ReturnType<typeof createValuesObject>
        >;
      },
      renewCaller(expiresAtMs: number) {
        const result = callerStore.renewNodeLease({
          commandId: randomUUID(),
          commandCreatedAtMs: clock.nowEpochMs(),
          input: {
            nodeId: lease.nodeId,
            processGeneration: lease.processGeneration,
            expectedRenewalId: lease.renewalId,
            nextRenewalId: randomUUID(),
            attemptedAtMs: clock.nowEpochMs(),
            expiresAtMs,
          },
        });
        if (result.outcome === "renewed") {
          Object.assign(lease, result.lease);
        }
        return result;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
