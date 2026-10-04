import type { RpcTarget } from "capnweb";

import type { GraftObjectRoutingState } from "../graft/graft-control-store";
import type { GraftRuntimeNodeIdentity } from "../graft/graft-node-authority";
import type { NodePeerObjectRoute } from "../rpc/node-peer-rpc";
import { readNodeRuntimeEpochMilliseconds, type NodeRuntimeClock } from "./node-runtime-clock";

/** Provides the control reads and peer delivery used by authority-bound namespace resolution. */
export type NodeObjectPeerRouting = {
  identity: GraftRuntimeNodeIdentity;
  maximumClockSkewMs: number;
  readObjectRoutingState(objectId: string): GraftObjectRoutingState | null;
  ensureObjectProvisioned(objectId: string): void;
  getRemoteObject(route: NodePeerObjectRoute): Promise<RpcTarget>;
};

/** Decides whether this node may ask the durable claim protocol to activate an object locally. */
export function shouldAttemptLocalObjectActivation(
  routingState: GraftObjectRoutingState,
  peerRouting: NodeObjectPeerRouting,
  clock: NodeRuntimeClock,
): boolean {
  if (routingState.kind === "unowned" || routingState.kind === "owned-without-node-lease") {
    return true;
  }
  if (
    routingState.ownership.ownerNodeId === peerRouting.identity.nodeId &&
    routingState.ownerLease.processGeneration === peerRouting.identity.processGeneration
  ) {
    return true;
  }
  const takeoverCutoffMs = Math.max(
    0,
    readNodeRuntimeEpochMilliseconds(clock) - peerRouting.maximumClockSkewMs,
  );
  return routingState.ownerLease.expiresAtMs <= takeoverCutoffMs;
}

/** Constructs the exact owner token sent during authenticated peer object delivery. */
export function createNodePeerObjectRoute(
  binding: string,
  name: string,
  routingState: GraftObjectRoutingState & { kind: "owned-with-node-lease" },
): NodePeerObjectRoute {
  return {
    objectId: routingState.ownership.objectId,
    binding,
    name,
    expectedEpoch: routingState.ownership.epoch,
    expectedClaimId: routingState.ownership.claimId,
    expectedOwnerNodeId: routingState.ownership.ownerNodeId,
    expectedOwnerProcessGeneration: routingState.ownerLease.processGeneration,
    expectedOwnerCompatibilityVersion: routingState.ownerLease.compatibilityVersion,
    peerWebSocketAddress: routingState.ownerLease.privateAddress,
  };
}

/** Rejects stale peer delivery before an application method reaches the local object worker. */
export function requireExpectedLocalPeerRoute(
  routingState: GraftObjectRoutingState | null,
  route: NodePeerObjectRoute,
  identity: GraftRuntimeNodeIdentity,
  clock: NodeRuntimeClock,
): void {
  if (
    route.objectId !== `${route.binding}:${route.name}` ||
    routingState?.kind !== "owned-with-node-lease" ||
    routingState.ownership.objectId !== route.objectId ||
    routingState.ownership.epoch !== route.expectedEpoch ||
    routingState.ownership.claimId !== route.expectedClaimId ||
    routingState.ownership.ownerNodeId !== identity.nodeId ||
    routingState.ownerLease.nodeId !== identity.nodeId ||
    routingState.ownerLease.processGeneration !== identity.processGeneration ||
    routingState.ownerLease.compatibilityVersion !== identity.compatibilityVersion ||
    route.expectedOwnerNodeId !== identity.nodeId ||
    route.expectedOwnerProcessGeneration !== identity.processGeneration ||
    route.expectedOwnerCompatibilityVersion !== identity.compatibilityVersion ||
    route.peerWebSocketAddress !== identity.privateAddress ||
    routingState.ownerLease.expiresAtMs <= readNodeRuntimeEpochMilliseconds(clock)
  ) {
    throw new Error(`NODE_PEER_RPC_STALE_ROUTE:${route.objectId}`);
  }
}

/** Identifies claim outcomes that prove no application method was delivered. */
export function isPreDeliveryObjectClaimRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("GRAFT_OBJECT_ACTIVATION_CLAIM_REJECTED:current-owner-live") ||
    message.includes("GRAFT_OBJECT_ACTIVATION_CLAIM_REJECTED:ownership-changed")
  );
}

/** Identifies an explicit receiver refusal that is safe to resolve again. */
export function isPreDeliveryPeerRouteRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("NODE_PEER_RPC_STALE_ROUTE");
}
