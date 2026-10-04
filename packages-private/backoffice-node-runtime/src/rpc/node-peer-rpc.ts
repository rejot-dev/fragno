import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { newWebSocketRpcSession, RpcTarget } from "capnweb";

import type { GraftControlStore } from "../graft/graft-control-store";
import type { GraftRuntimeNodeIdentity } from "../graft/graft-node-authority";
import {
  readNodeRuntimeEpochMilliseconds,
  type NodeRuntimeClock,
} from "../runtime/node-runtime-clock";
import { NodePeerAuthority } from "./node-peer-authority";

const NODE_PEER_AUTHENTICATION_PROTOCOL = "fragno-node-peer-auth-v1";
const NODE_PEER_AUTHENTICATION_PROOF_BYTES = 32;

/** Binds peer object delivery to the exact ready owner observed by the caller. */
export type NodePeerObjectRoute = {
  objectId: string;
  binding: string;
  name: string;
  expectedEpoch: string;
  expectedClaimId: string;
  expectedOwnerNodeId: string;
  expectedOwnerProcessGeneration: string;
  expectedOwnerCompatibilityVersion: number;
  peerWebSocketAddress: string;
};

/** Configures authenticated Cap'n Web sessions between authority-bound runtime nodes. */
export type NodePeerRpcConfig = {
  authenticationSecret: string;
  authenticationWindowMs: number;
};

/** Supplies exact local activation admission after the peer session is authenticated. */
export type NodePeerObjectProvider = {
  getLocalObjectForPeer(
    route: NodePeerObjectRoute,
    assertPeerAuthority: () => void,
  ): Promise<RpcTarget>;
};

type NodePeerAuthenticationInput = {
  protocol: typeof NODE_PEER_AUTHENTICATION_PROTOCOL;
  callerNodeId: string;
  callerProcessGeneration: string;
  callerCompatibilityVersion: number;
  expectedReceiverNodeId: string;
  expectedReceiverProcessGeneration: string;
  expectedReceiverCompatibilityVersion: number;
  issuedAtMs: number;
  nonce: string;
  proof: string;
};

type NodePeerAuthenticationResult = {
  receiverProof: string;
  session: NodePeerSessionTarget;
};

type NodePeerHandshakeApi = {
  authenticate(input: NodePeerAuthenticationInput): Promise<NodePeerAuthenticationResult>;
};

type NodePeerSessionApi = {
  getObject(route: NodePeerObjectRoute): Promise<RpcTarget>;
};

type DisposableNodePeerRpcRoot = {
  onRpcBroken(callback: (error: unknown) => void): void;
  [Symbol.dispose](): void;
};

type NodePeerHandshakeStub = DisposableNodePeerRpcRoot & {
  authenticate(input: NodePeerAuthenticationInput): Promise<{
    receiverProof: string;
    session: NodePeerSessionStub;
  }>;
};

type NodePeerSessionStub = {
  getObject(route: NodePeerObjectRoute): Promise<RpcTarget>;
};

type CachedNodePeerSession = {
  root: NodePeerHandshakeStub;
  session: NodePeerSessionStub;
};

/** Owns incoming and outgoing authenticated peer sessions for one process incarnation. */
export class NodePeerRpcNetwork {
  readonly #peerAuthority: NodePeerAuthority;
  readonly #clock: NodeRuntimeClock;
  readonly #identity: GraftRuntimeNodeIdentity;
  readonly #config: NodePeerRpcConfig;
  readonly #provider: NodePeerObjectProvider;
  readonly #usedAuthenticationNonces = new Map<string, number>();
  readonly #outgoingSessions = new Map<string, Promise<CachedNodePeerSession>>();
  readonly #incomingRoots = new Set<DisposableNodePeerRpcRoot>();
  #closed = false;

  constructor(options: {
    controlStore: Pick<GraftControlStore, "readNodeLease">;
    maximumClockSkewMs: number;
    clock: NodeRuntimeClock;
    identity: GraftRuntimeNodeIdentity;
    config: NodePeerRpcConfig;
    provider: NodePeerObjectProvider;
  }) {
    validateNodePeerRpcConfig(options.config);
    validateNodePeerWebSocketAddress(options.identity.privateAddress);
    if (!Number.isSafeInteger(options.maximumClockSkewMs) || options.maximumClockSkewMs < 0) {
      throw new Error("NODE_PEER_RPC_CLOCK_SKEW_INVALID");
    }
    this.#peerAuthority = new NodePeerAuthority(options);
    this.#clock = options.clock;
    this.#identity = { ...options.identity };
    this.#config = { ...options.config };
    this.#provider = options.provider;
  }

  /** Accepts an already-upgraded WebSocket and exposes only the authenticated peer handshake. */
  acceptWebSocket(webSocket: WebSocket): void {
    this.#requireOpen();
    const root = newWebSocketRpcSession(
      webSocket,
      new NodePeerHandshakeTarget({
        peerAuthority: this.#peerAuthority,
        requireNetworkOpen: () => {
          this.#requireOpen();
        },
        clock: this.#clock,
        identity: this.#identity,
        config: this.#config,
        provider: this.#provider,
        claimAuthenticationNonce: (nonce, expiresAtMs) => {
          this.#claimAuthenticationNonce(nonce, expiresAtMs);
        },
      }),
    ) as unknown as DisposableNodePeerRpcRoot;
    this.#incomingRoots.add(root);
    root.onRpcBroken(() => {
      this.#incomingRoots.delete(root);
    });
  }

  /** Resolves one exact remote owner without replaying later object method calls. */
  async getRemoteObject(route: NodePeerObjectRoute): Promise<RpcTarget> {
    this.#requireOpen();
    validateNodePeerObjectRoute(route);
    if (route.expectedOwnerNodeId === this.#identity.nodeId) {
      throw new Error("NODE_PEER_RPC_REMOTE_ROUTE_IS_LOCAL");
    }
    const session = await this.#getAuthenticatedSession(route);
    try {
      return await session.session.getObject(route);
    } catch (error) {
      if (isNodePeerSessionFailure(error)) {
        this.#discardOutgoingSession(route, session);
      }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const root of this.#incomingRoots) {
      root[Symbol.dispose]();
    }
    this.#incomingRoots.clear();
    for (const pending of this.#outgoingSessions.values()) {
      void pending.then(
        ({ root }) => {
          root[Symbol.dispose]();
        },
        () => {},
      );
    }
    this.#outgoingSessions.clear();
  }

  async #getAuthenticatedSession(route: NodePeerObjectRoute): Promise<CachedNodePeerSession> {
    const key = nodePeerSessionKey(route);
    let pending = this.#outgoingSessions.get(key);
    if (!pending) {
      pending = this.#connectAuthenticatedSession(route).catch((error: unknown) => {
        if (this.#outgoingSessions.get(key) === pending) {
          this.#outgoingSessions.delete(key);
        }
        throw error;
      });
      this.#outgoingSessions.set(key, pending);
    }
    return await pending;
  }

  async #connectAuthenticatedSession(route: NodePeerObjectRoute): Promise<CachedNodePeerSession> {
    const root = newWebSocketRpcSession<NodePeerHandshakeApi>(
      route.peerWebSocketAddress,
    ) as unknown as NodePeerHandshakeStub;
    const issuedAtMs = readNodeRuntimeEpochMilliseconds(this.#clock);
    const nonce = randomUUID();
    const unsignedInput = {
      protocol: NODE_PEER_AUTHENTICATION_PROTOCOL,
      callerNodeId: this.#identity.nodeId,
      callerProcessGeneration: this.#identity.processGeneration,
      callerCompatibilityVersion: this.#identity.compatibilityVersion,
      expectedReceiverNodeId: route.expectedOwnerNodeId,
      expectedReceiverProcessGeneration: route.expectedOwnerProcessGeneration,
      expectedReceiverCompatibilityVersion: route.expectedOwnerCompatibilityVersion,
      issuedAtMs,
      nonce,
    } satisfies Omit<NodePeerAuthenticationInput, "proof">;
    const proof = createNodePeerAuthenticationProof(
      this.#config.authenticationSecret,
      "request",
      unsignedInput,
    );
    try {
      const result = await root.authenticate({ ...unsignedInput, proof });
      const expectedReceiverProof = createNodePeerAuthenticationProof(
        this.#config.authenticationSecret,
        "response",
        unsignedInput,
      );
      if (!equalNodePeerAuthenticationProof(result.receiverProof, expectedReceiverProof)) {
        throw new Error("NODE_PEER_RPC_RECEIVER_AUTHENTICATION_FAILED");
      }
      const cached = { root, session: result.session };
      root.onRpcBroken(() => {
        this.#discardOutgoingSession(route, cached);
      });
      return cached;
    } catch (error) {
      root[Symbol.dispose]();
      throw error;
    }
  }

  #discardOutgoingSession(route: NodePeerObjectRoute, session: CachedNodePeerSession): void {
    const key = nodePeerSessionKey(route);
    const pending = this.#outgoingSessions.get(key);
    if (!pending) {
      return;
    }
    void pending.then((resolved) => {
      if (resolved !== session || this.#outgoingSessions.get(key) !== pending) {
        return;
      }
      this.#outgoingSessions.delete(key);
      resolved.root[Symbol.dispose]();
    });
  }

  #claimAuthenticationNonce(nonce: string, expiresAtMs: number): void {
    const nowEpochMs = readNodeRuntimeEpochMilliseconds(this.#clock);
    for (const [existingNonce, existingExpiryMs] of this.#usedAuthenticationNonces) {
      if (existingExpiryMs < nowEpochMs) {
        this.#usedAuthenticationNonces.delete(existingNonce);
      }
    }
    if (this.#usedAuthenticationNonces.has(nonce)) {
      throw new Error("NODE_PEER_RPC_AUTHENTICATION_REPLAYED");
    }
    this.#usedAuthenticationNonces.set(nonce, expiresAtMs);
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new Error("NODE_PEER_RPC_NETWORK_CLOSED");
    }
  }
}

class NodePeerHandshakeTarget extends RpcTarget implements NodePeerHandshakeApi {
  readonly #peerAuthority: NodePeerAuthority;
  readonly #requireNetworkOpen: () => void;
  readonly #clock: NodeRuntimeClock;
  readonly #identity: GraftRuntimeNodeIdentity;
  readonly #config: NodePeerRpcConfig;
  readonly #provider: NodePeerObjectProvider;
  readonly #claimAuthenticationNonce: (nonce: string, expiresAtMs: number) => void;
  #authenticated = false;

  constructor(options: {
    peerAuthority: NodePeerAuthority;
    requireNetworkOpen: () => void;
    clock: NodeRuntimeClock;
    identity: GraftRuntimeNodeIdentity;
    config: NodePeerRpcConfig;
    provider: NodePeerObjectProvider;
    claimAuthenticationNonce: (nonce: string, expiresAtMs: number) => void;
  }) {
    super();
    this.#peerAuthority = options.peerAuthority;
    this.#requireNetworkOpen = options.requireNetworkOpen;
    this.#clock = options.clock;
    this.#identity = options.identity;
    this.#config = options.config;
    this.#provider = options.provider;
    this.#claimAuthenticationNonce = options.claimAuthenticationNonce;
  }

  async authenticate(inputValue: unknown): Promise<NodePeerAuthenticationResult> {
    this.#requireNetworkOpen();
    if (this.#authenticated) {
      throw new Error("NODE_PEER_RPC_CONNECTION_ALREADY_AUTHENTICATED");
    }
    const input = validateNodePeerAuthenticationInput(inputValue);
    if (
      input.expectedReceiverNodeId !== this.#identity.nodeId ||
      input.expectedReceiverProcessGeneration !== this.#identity.processGeneration ||
      input.expectedReceiverCompatibilityVersion !== this.#identity.compatibilityVersion
    ) {
      throw new Error("NODE_PEER_RPC_RECEIVER_IDENTITY_MISMATCH");
    }
    const nowEpochMs = readNodeRuntimeEpochMilliseconds(this.#clock);
    const earliestIssuedAtMs = nowEpochMs - this.#config.authenticationWindowMs;
    const latestIssuedAtMs = nowEpochMs + this.#config.authenticationWindowMs;
    if (input.issuedAtMs < earliestIssuedAtMs || input.issuedAtMs > latestIssuedAtMs) {
      throw new Error("NODE_PEER_RPC_AUTHENTICATION_EXPIRED");
    }
    const unsignedInput = {
      protocol: input.protocol,
      callerNodeId: input.callerNodeId,
      callerProcessGeneration: input.callerProcessGeneration,
      callerCompatibilityVersion: input.callerCompatibilityVersion,
      expectedReceiverNodeId: input.expectedReceiverNodeId,
      expectedReceiverProcessGeneration: input.expectedReceiverProcessGeneration,
      expectedReceiverCompatibilityVersion: input.expectedReceiverCompatibilityVersion,
      issuedAtMs: input.issuedAtMs,
      nonce: input.nonce,
    } satisfies Omit<NodePeerAuthenticationInput, "proof">;
    const expectedProof = createNodePeerAuthenticationProof(
      this.#config.authenticationSecret,
      "request",
      unsignedInput,
    );
    if (!equalNodePeerAuthenticationProof(input.proof, expectedProof)) {
      throw new Error("NODE_PEER_RPC_CALLER_AUTHENTICATION_FAILED");
    }
    this.#claimAuthenticationNonce(
      input.nonce,
      input.issuedAtMs + this.#config.authenticationWindowMs,
    );
    const requirePeerAuthority = this.#peerAuthority.confirmCaller({
      nodeId: input.callerNodeId,
      processGeneration: input.callerProcessGeneration,
      compatibilityVersion: input.callerCompatibilityVersion,
    });
    this.#authenticated = true;
    return {
      receiverProof: createNodePeerAuthenticationProof(
        this.#config.authenticationSecret,
        "response",
        unsignedInput,
      ),
      session: new NodePeerSessionTarget(this.#provider, () => {
        this.#requireNetworkOpen();
        requirePeerAuthority();
      }),
    };
  }
}

class NodePeerSessionTarget extends RpcTarget implements NodePeerSessionApi {
  readonly #provider: NodePeerObjectProvider;
  readonly #assertPeerAuthority: () => void;

  constructor(provider: NodePeerObjectProvider, assertPeerAuthority: () => void) {
    super();
    this.#provider = provider;
    this.#assertPeerAuthority = assertPeerAuthority;
  }

  async getObject(routeValue: unknown): Promise<RpcTarget> {
    this.#assertPeerAuthority();
    const route = validateNodePeerObjectRoute(routeValue);
    const object = await this.#provider.getLocalObjectForPeer(route, this.#assertPeerAuthority);
    this.#assertPeerAuthority();
    return object;
  }
}

function createNodePeerAuthenticationProof(
  secret: string,
  direction: "request" | "response",
  input: Omit<NodePeerAuthenticationInput, "proof">,
): string {
  return createHmac("sha256", secret)
    .update(
      [
        NODE_PEER_AUTHENTICATION_PROTOCOL,
        direction,
        input.callerNodeId,
        input.callerProcessGeneration,
        String(input.callerCompatibilityVersion),
        input.expectedReceiverNodeId,
        input.expectedReceiverProcessGeneration,
        String(input.expectedReceiverCompatibilityVersion),
        String(input.issuedAtMs),
        input.nonce,
      ].join("\n"),
    )
    .digest("base64url");
}

function equalNodePeerAuthenticationProof(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return (
    actualBytes.length === NODE_PEER_AUTHENTICATION_PROOF_BYTES &&
    expectedBytes.length === NODE_PEER_AUTHENTICATION_PROOF_BYTES &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function nodePeerSessionKey(route: NodePeerObjectRoute): string {
  return [
    route.expectedOwnerNodeId,
    route.expectedOwnerProcessGeneration,
    String(route.expectedOwnerCompatibilityVersion),
    route.peerWebSocketAddress,
  ].join("\n");
}

function isNodePeerSessionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("WebSocket") ||
    message.includes("RPC") ||
    message.includes("closed") ||
    message.includes("disconnect")
  );
}

function validateNodePeerRpcConfig(config: NodePeerRpcConfig): void {
  if (config.authenticationSecret.length < 32) {
    throw new Error("NODE_PEER_RPC_AUTHENTICATION_SECRET_INVALID");
  }
  if (!Number.isSafeInteger(config.authenticationWindowMs) || config.authenticationWindowMs <= 0) {
    throw new Error("NODE_PEER_RPC_AUTHENTICATION_WINDOW_INVALID");
  }
}

function validateNodePeerAuthenticationInput(value: unknown): NodePeerAuthenticationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("NODE_PEER_RPC_AUTHENTICATION_INPUT_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (record["protocol"] !== NODE_PEER_AUTHENTICATION_PROTOCOL) {
    throw new Error("NODE_PEER_RPC_PROTOCOL_UNSUPPORTED");
  }
  return {
    protocol: NODE_PEER_AUTHENTICATION_PROTOCOL,
    callerNodeId: requireNonEmptyNodePeerString(record["callerNodeId"], "callerNodeId"),
    callerProcessGeneration: requireNonEmptyNodePeerString(
      record["callerProcessGeneration"],
      "callerProcessGeneration",
    ),
    callerCompatibilityVersion: requireNonNegativeNodePeerInteger(
      record["callerCompatibilityVersion"],
      "callerCompatibilityVersion",
    ),
    expectedReceiverNodeId: requireNonEmptyNodePeerString(
      record["expectedReceiverNodeId"],
      "expectedReceiverNodeId",
    ),
    expectedReceiverProcessGeneration: requireNonEmptyNodePeerString(
      record["expectedReceiverProcessGeneration"],
      "expectedReceiverProcessGeneration",
    ),
    expectedReceiverCompatibilityVersion: requireNonNegativeNodePeerInteger(
      record["expectedReceiverCompatibilityVersion"],
      "expectedReceiverCompatibilityVersion",
    ),
    issuedAtMs: requireNonNegativeNodePeerInteger(record["issuedAtMs"], "issuedAtMs"),
    nonce: requireNonEmptyNodePeerString(record["nonce"], "nonce"),
    proof: requireNonEmptyNodePeerString(record["proof"], "proof"),
  };
}

function validateNodePeerObjectRoute(value: unknown): NodePeerObjectRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("NODE_PEER_RPC_OBJECT_ROUTE_INVALID");
  }
  const record = value as Record<string, unknown>;
  const peerWebSocketAddress = requireNonEmptyNodePeerString(
    record["peerWebSocketAddress"],
    "peerWebSocketAddress",
  );
  validateNodePeerWebSocketAddress(peerWebSocketAddress);
  return {
    objectId: requireNonEmptyNodePeerString(record["objectId"], "objectId"),
    binding: requireNonEmptyNodePeerString(record["binding"], "binding"),
    name: requireNonEmptyNodePeerString(record["name"], "name"),
    expectedEpoch: requireNonEmptyNodePeerString(record["expectedEpoch"], "expectedEpoch"),
    expectedClaimId: requireNonEmptyNodePeerString(record["expectedClaimId"], "expectedClaimId"),
    expectedOwnerNodeId: requireNonEmptyNodePeerString(
      record["expectedOwnerNodeId"],
      "expectedOwnerNodeId",
    ),
    expectedOwnerProcessGeneration: requireNonEmptyNodePeerString(
      record["expectedOwnerProcessGeneration"],
      "expectedOwnerProcessGeneration",
    ),
    expectedOwnerCompatibilityVersion: requireNonNegativeNodePeerInteger(
      record["expectedOwnerCompatibilityVersion"],
      "expectedOwnerCompatibilityVersion",
    ),
    peerWebSocketAddress,
  };
}

function validateNodePeerWebSocketAddress(value: string): void {
  let address: URL;
  try {
    address = new URL(value);
  } catch (cause) {
    throw new Error("NODE_PEER_RPC_WEBSOCKET_ADDRESS_INVALID", { cause });
  }
  if (address.protocol !== "ws:" && address.protocol !== "wss:") {
    throw new Error("NODE_PEER_RPC_WEBSOCKET_ADDRESS_INVALID");
  }
}

function requireNonEmptyNodePeerString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`NODE_PEER_RPC_STRING_INVALID:${field}`);
  }
  return value;
}

function requireNonNegativeNodePeerInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`NODE_PEER_RPC_INTEGER_INVALID:${field}`);
  }
  return value;
}
