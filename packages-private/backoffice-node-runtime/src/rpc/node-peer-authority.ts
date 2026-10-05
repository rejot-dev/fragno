import type { GraftControlStore } from "../graft/graft-control-store";
import type { GraftRuntimeNodeIdentity } from "../graft/graft-node-authority";
import {
  readNodeRuntimeEpochMilliseconds,
  readNodeRuntimeMonotonicMilliseconds,
  type NodeRuntimeClock,
} from "../runtime/node-runtime-clock";

type NodePeerAuthorityWindow = {
  expiresAtEpochMs: number;
  expiresAtMonotonicMs: number;
};

/** Confirms session-scoped peer leases against a node-wide, rollback-resistant authority clock. */
export class NodePeerAuthority {
  readonly #controlStore: Pick<GraftControlStore, "readNodeLease">;
  readonly #clock: NodeRuntimeClock;
  readonly #maximumClockSkewMs: number;
  #epochOffsetMs: number;

  constructor(options: {
    controlStore: Pick<GraftControlStore, "readNodeLease">;
    clock: NodeRuntimeClock;
    maximumClockSkewMs: number;
  }) {
    this.#controlStore = options.controlStore;
    this.#clock = options.clock;
    this.#maximumClockSkewMs = options.maximumClockSkewMs;
    const monotonicMs = readNodeRuntimeMonotonicMilliseconds(this.#clock);
    this.#epochOffsetMs = readNodeRuntimeEpochMilliseconds(this.#clock) - monotonicMs;
  }

  confirmCaller(
    caller: Pick<GraftRuntimeNodeIdentity, "nodeId" | "processGeneration" | "compatibilityVersion">,
  ): () => void {
    let window: NodePeerAuthorityWindow | null = null;
    const requireLive = () => {
      const attemptMonotonicMs = readNodeRuntimeMonotonicMilliseconds(this.#clock);
      const attemptEpochMs = this.#readConservativeEpoch(attemptMonotonicMs);
      if (
        window !== null &&
        attemptEpochMs < window.expiresAtEpochMs &&
        attemptMonotonicMs < window.expiresAtMonotonicMs
      ) {
        return;
      }

      // Node identities cannot be replaced and leases only extend. No arbitrary cache TTL or
      // per-call refresh is needed inside a confirmed window; expiry requires a new read.
      window = null;
      const lease = this.#controlStore.readNodeLease(caller.nodeId);
      if (!lease) {
        throw new Error("NODE_PEER_RPC_CALLER_NODE_MISSING");
      }
      if (
        lease.processGeneration !== caller.processGeneration ||
        lease.compatibilityVersion !== caller.compatibilityVersion
      ) {
        throw new Error("NODE_PEER_RPC_CALLER_IDENTITY_MISMATCH");
      }
      const expiresAtEpochMs = lease.expiresAtMs - this.#maximumClockSkewMs;
      const expiresAtMonotonicMs = attemptMonotonicMs + expiresAtEpochMs - attemptEpochMs;
      const confirmationMonotonicMs = readNodeRuntimeMonotonicMilliseconds(this.#clock);
      if (
        this.#readConservativeEpoch(confirmationMonotonicMs) >= expiresAtEpochMs ||
        confirmationMonotonicMs >= expiresAtMonotonicMs
      ) {
        throw new Error("NODE_PEER_RPC_CALLER_LEASE_EXPIRED");
      }
      window = { expiresAtEpochMs, expiresAtMonotonicMs };
    };
    requireLive();
    return requireLive;
  }

  #readConservativeEpoch(monotonicMs: number): number {
    // Remember observed wall-clock advances across sessions. Neither a rollback nor a new
    // handshake may gift the same lease a new deadline, even when its refresh succeeds.
    this.#epochOffsetMs = Math.max(
      this.#epochOffsetMs,
      readNodeRuntimeEpochMilliseconds(this.#clock) - monotonicMs,
    );
    return monotonicMs + this.#epochOffsetMs;
  }
}
