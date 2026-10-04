import { randomUUID } from "node:crypto";

import {
  readNodeRuntimeEpochMilliseconds,
  readNodeRuntimeMonotonicMilliseconds,
  type NodeRuntimeClock,
} from "../runtime/node-runtime-clock";
import {
  GraftControlStore,
  type GraftControlCommand,
  type GraftRenewNodeLeaseInput,
  type GraftRenewNodeLeaseResult,
} from "./graft-control-store";

/** Identifies one process incarnation, never a renewable lease attempt. */
export type GraftRuntimeNodeIdentity = {
  nodeId: string;
  processGeneration: string;
  privateAddress: string;
  applicationOrigin: string;
  compatibilityVersion: number;
};

/** Configure lease renewal from measured storage latency and a declared inter-node clock skew bound. */
export type GraftNodeLeasePolicy = {
  leaseDurationMs: number;
  renewalIntervalMs: number;
  renewalRetryIntervalMs: number;
  selfFenceSafetyMarginMs: number;
  maximumClockSkewMs: number;
};

/** A durably confirmed node lease with an attempt-start-based monotonic self-fencing deadline. */
export type GraftNodeAuthorityWindow = {
  nodeId: string;
  processGeneration: string;
  renewalId: string;
  leaseExpiresAtEpochMs: number;
  selfFenceAtMonotonicMs: number;
};

/** Terminal reasons cannot be cleared by a delayed renewal response. */
export type GraftNodeAuthorityFenceReason =
  | { kind: "registration-confirmed-too-late" }
  | { kind: "authority-deadline-exhausted" }
  | { kind: "renewal-confirmed-too-late" }
  | {
      kind: "renewal-rejected";
      outcome: Exclude<GraftRenewNodeLeaseResult["outcome"], "renewed">;
    };

/** Serving authority is distinct from terminal fencing and caller-coordinated closure. */
export type GraftNodeAuthorityStatus =
  | {
      state: "serving";
      window: GraftNodeAuthorityWindow;
      nextActionAtMonotonicMs: number;
    }
  | {
      state: "fenced";
      reason: GraftNodeAuthorityFenceReason;
      fencedAtMonotonicMs: number;
    }
  | { state: "closed" };

type PendingNodeRenewal = {
  command: GraftControlCommand<GraftRenewNodeLeaseInput>;
  attemptMonotonicMs: number;
};

/** Owns one control store and renewable node authority; unconfirmed commands never extend authority. */
export class GraftNodeAuthority {
  readonly #store: GraftControlStore;
  readonly #clock: NodeRuntimeClock;
  readonly #policy: GraftNodeLeasePolicy;
  #status: GraftNodeAuthorityStatus;
  #pendingRenewal: PendingNodeRenewal | null = null;

  constructor(options: {
    controlStore: GraftControlStore;
    clock: NodeRuntimeClock;
    identity: GraftRuntimeNodeIdentity;
    policy: GraftNodeLeasePolicy;
  }) {
    validateNodeLeasePolicy(options.policy);
    this.#store = options.controlStore;
    this.#clock = options.clock;
    this.#policy = { ...options.policy };
    const attemptEpochMs = readNodeRuntimeEpochMilliseconds(this.#clock);
    const attemptMonotonicMs = readNodeRuntimeMonotonicMilliseconds(this.#clock);
    const lease = {
      ...options.identity,
      renewalId: randomUUID(),
      expiresAtMs: attemptEpochMs + this.#policy.leaseDurationMs,
    };
    const result = this.#store.registerNode({
      commandId: randomUUID(),
      commandCreatedAtMs: attemptEpochMs,
      input: { lease },
    });
    if (result.outcome !== "registered") {
      throw new Error(`GRAFT_NODE_RUNTIME_REGISTRATION_REJECTED:${lease.nodeId}`);
    }
    const window: GraftNodeAuthorityWindow = {
      nodeId: lease.nodeId,
      processGeneration: lease.processGeneration,
      renewalId: lease.renewalId,
      leaseExpiresAtEpochMs: lease.expiresAtMs,
      selfFenceAtMonotonicMs:
        attemptMonotonicMs + this.#policy.leaseDurationMs - this.#policy.selfFenceSafetyMarginMs,
    };
    this.#status = {
      state: "serving",
      window,
      nextActionAtMonotonicMs: attemptMonotonicMs + this.#policy.renewalIntervalMs,
    };
    if (
      readNodeRuntimeMonotonicMilliseconds(this.#clock) >= window.selfFenceAtMonotonicMs ||
      readNodeRuntimeEpochMilliseconds(this.#clock) >= window.leaseExpiresAtEpochMs
    ) {
      this.#fence({ kind: "registration-confirmed-too-late" });
      throw new Error("GRAFT_NODE_RUNTIME_REGISTRATION_CONFIRMED_TOO_LATE");
    }
  }

  readStatus(): GraftNodeAuthorityStatus {
    if (
      this.#status.state === "serving" &&
      (readNodeRuntimeMonotonicMilliseconds(this.#clock) >=
        this.#status.window.selfFenceAtMonotonicMs ||
        readNodeRuntimeEpochMilliseconds(this.#clock) >= this.#status.window.leaseExpiresAtEpochMs)
    ) {
      this.#fence({ kind: "authority-deadline-exhausted" });
    }
    if (this.#status.state === "serving") {
      return { ...this.#status, window: { ...this.#status.window } };
    }
    if (this.#status.state === "fenced") {
      return { ...this.#status, reason: { ...this.#status.reason } };
    }
    return { state: "closed" };
  }

  requireServingWindow(): GraftNodeAuthorityWindow {
    const status = this.readStatus();
    if (status.state !== "serving") {
      throw new Error("NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED");
    }
    return status.window;
  }

  tick(): GraftNodeAuthorityStatus {
    const previous = this.readStatus();
    const nowMonotonicMs = readNodeRuntimeMonotonicMilliseconds(this.#clock);
    if (previous.state !== "serving" || nowMonotonicMs < previous.nextActionAtMonotonicMs) {
      return previous;
    }
    if (!this.#pendingRenewal) {
      const attemptEpochMs = readNodeRuntimeEpochMilliseconds(this.#clock);
      this.#pendingRenewal = {
        attemptMonotonicMs: nowMonotonicMs,
        command: {
          commandId: randomUUID(),
          commandCreatedAtMs: attemptEpochMs,
          input: {
            nodeId: previous.window.nodeId,
            processGeneration: previous.window.processGeneration,
            expectedRenewalId: previous.window.renewalId,
            nextRenewalId: randomUUID(),
            attemptedAtMs: attemptEpochMs,
            expiresAtMs: attemptEpochMs + this.#policy.leaseDurationMs,
          },
        },
      };
    }
    const pending = this.#pendingRenewal;
    let result: GraftRenewNodeLeaseResult;
    try {
      result = this.#store.renewNodeLease(pending.command);
    } catch {
      // Retain the exact semantic command: it may already have a durable receipt remotely.
      if (
        readNodeRuntimeMonotonicMilliseconds(this.#clock) >= previous.window.selfFenceAtMonotonicMs
      ) {
        return this.#fence({ kind: "authority-deadline-exhausted" });
      }
      this.#status = {
        ...previous,
        nextActionAtMonotonicMs: Math.min(
          previous.window.selfFenceAtMonotonicMs,
          readNodeRuntimeMonotonicMilliseconds(this.#clock) + this.#policy.renewalRetryIntervalMs,
        ),
      };
      return this.readStatus();
    }
    const nextDeadline =
      pending.attemptMonotonicMs +
      this.#policy.leaseDurationMs -
      this.#policy.selfFenceSafetyMarginMs;
    const confirmationMonotonicMs = readNodeRuntimeMonotonicMilliseconds(this.#clock);
    if (
      confirmationMonotonicMs >= previous.window.selfFenceAtMonotonicMs ||
      confirmationMonotonicMs >= nextDeadline ||
      readNodeRuntimeEpochMilliseconds(this.#clock) >= previous.window.leaseExpiresAtEpochMs
    ) {
      return this.#fence({ kind: "renewal-confirmed-too-late" });
    }
    if (result.outcome !== "renewed") {
      return this.#fence({ kind: "renewal-rejected", outcome: result.outcome });
    }
    this.#pendingRenewal = null;
    this.#status = {
      state: "serving",
      window: {
        nodeId: result.lease.nodeId,
        processGeneration: result.lease.processGeneration,
        renewalId: result.lease.renewalId,
        leaseExpiresAtEpochMs: result.lease.expiresAtMs,
        selfFenceAtMonotonicMs: nextDeadline,
      },
      nextActionAtMonotonicMs: Math.min(
        nextDeadline,
        Math.max(
          confirmationMonotonicMs + 1,
          pending.attemptMonotonicMs + this.#policy.renewalIntervalMs,
        ),
      ),
    };
    return this.readStatus();
  }

  close(): void {
    this.#status = { state: "closed" };
    this.#pendingRenewal = null;
    this.#store.close();
  }

  #fence(reason: GraftNodeAuthorityFenceReason): GraftNodeAuthorityStatus {
    this.#status = {
      state: "fenced",
      reason,
      fencedAtMonotonicMs: readNodeRuntimeMonotonicMilliseconds(this.#clock),
    };
    this.#pendingRenewal = null;
    return this.readStatus();
  }
}

function validateNodeLeasePolicy(policy: GraftNodeLeasePolicy): void {
  for (const value of [
    policy.leaseDurationMs,
    policy.renewalIntervalMs,
    policy.renewalRetryIntervalMs,
    policy.selfFenceSafetyMarginMs,
    policy.maximumClockSkewMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("GRAFT_NODE_LEASE_POLICY_INVALID");
    }
  }
  const authorityDurationMs = policy.leaseDurationMs - policy.selfFenceSafetyMarginMs;
  if (
    policy.renewalIntervalMs <= 0 ||
    policy.renewalRetryIntervalMs <= 0 ||
    policy.renewalIntervalMs >= authorityDurationMs ||
    policy.renewalRetryIntervalMs >= authorityDurationMs ||
    policy.maximumClockSkewMs > policy.selfFenceSafetyMarginMs
  ) {
    throw new Error("GRAFT_NODE_LEASE_POLICY_INVALID");
  }
}
