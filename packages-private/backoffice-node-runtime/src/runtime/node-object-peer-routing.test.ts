import { assert, test } from "vitest";

import type { GraftObjectRoutingState } from "../graft/graft-control-store";
import {
  createNodePeerObjectRoute,
  requireExpectedLocalPeerRoute,
  shouldAttemptLocalObjectActivation,
  type NodeObjectPeerRouting,
} from "./node-object-peer-routing";
import { createManualNodeRuntimeClock } from "./node-runtime-clock";

const localIdentity = {
  nodeId: "node-local",
  processGeneration: "generation-local",
  privateAddress: "ws://node-local.test/peer",
  applicationOrigin: "http://node-local.test",
  compatibilityVersion: 1,
};

const localPeerRouting: NodeObjectPeerRouting = {
  identity: localIdentity,
  maximumClockSkewMs: 100,
  readObjectRoutingState() {
    throw new Error("NODE_OBJECT_PEER_ROUTING_TEST_READ_UNEXPECTED");
  },
  ensureObjectProvisioned() {
    throw new Error("NODE_OBJECT_PEER_ROUTING_TEST_PROVISION_UNEXPECTED");
  },
  async getRemoteObject() {
    throw new Error("NODE_OBJECT_PEER_ROUTING_TEST_DELIVERY_UNEXPECTED");
  },
};

test("a live remote lease routes remotely until the conservative takeover cutoff", () => {
  const clock = createManualNodeRuntimeClock(1_000);
  const routingState = createOwnedRoutingState({
    nodeId: "node-remote",
    processGeneration: "generation-remote",
    expiresAtMs: 901,
  });

  assert.equal(
    shouldAttemptLocalObjectActivation(routingState, localPeerRouting, clock.source),
    false,
  );

  clock.advanceBy(1);
  assert.equal(
    shouldAttemptLocalObjectActivation(routingState, localPeerRouting, clock.source),
    true,
  );
});

test("the exact local process generation rejoins its resident activation", () => {
  const clock = createManualNodeRuntimeClock(1_000);
  const routingState = createOwnedRoutingState({
    nodeId: localIdentity.nodeId,
    processGeneration: localIdentity.processGeneration,
    expiresAtMs: 10_000,
  });

  assert.equal(
    shouldAttemptLocalObjectActivation(routingState, localPeerRouting, clock.source),
    true,
  );
});

test("peer delivery rejects an epoch or owner incarnation that no longer matches", () => {
  const clock = createManualNodeRuntimeClock(1_000);
  const routingState = createOwnedRoutingState({
    nodeId: localIdentity.nodeId,
    processGeneration: localIdentity.processGeneration,
    expiresAtMs: 10_000,
  });
  const route = createNodePeerObjectRoute("COUNTER", "one", routingState);

  assert.doesNotThrow(() => {
    requireExpectedLocalPeerRoute(routingState, route, localIdentity, clock.source);
  });
  assert.throws(() => {
    requireExpectedLocalPeerRoute(
      { ...routingState, ownership: { ...routingState.ownership, epoch: "2" } },
      route,
      localIdentity,
      clock.source,
    );
  }, /NODE_PEER_RPC_STALE_ROUTE:COUNTER:one/);
});

function createOwnedRoutingState(input: {
  nodeId: string;
  processGeneration: string;
  expiresAtMs: number;
}): GraftObjectRoutingState & { kind: "owned-with-node-lease" } {
  return {
    kind: "owned-with-node-lease",
    ownership: {
      state: "ready",
      objectId: "COUNTER:one",
      remoteLogId: "remote-log-one",
      epoch: "1",
      ownerNodeId: input.nodeId,
      claimId: "claim-one",
    },
    ownerLease: {
      nodeId: input.nodeId,
      processGeneration: input.processGeneration,
      privateAddress:
        input.nodeId === localIdentity.nodeId
          ? localIdentity.privateAddress
          : "ws://node-remote.test/peer",
      applicationOrigin:
        input.nodeId === localIdentity.nodeId
          ? localIdentity.applicationOrigin
          : "http://node-remote.test",
      compatibilityVersion: 1,
      expiresAtMs: input.expiresAtMs,
      renewalId: "renewal-one",
    },
  };
}
