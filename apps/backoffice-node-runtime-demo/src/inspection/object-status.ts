import type { ObjectControlOverview } from "./object-control-overview";

/** Current control-plane interpretation of one demo object's execution availability. */
export type ObjectStatus = {
  kind:
    | "not-provisioned"
    | "unowned"
    | "restoring"
    | "active"
    | "owner-expired"
    | "owner-missing"
    | "control-inconsistent";
  label: string;
  explanation: string;
  ownerNodeId: string | null;
  ownerProcessGeneration: string | null;
  ownerLeaseExpiresAtMs: number | null;
};

/** Current control-plane interpretation of one demo object's durable alarm work. */
export type ObjectAlarmStatus = {
  kind: "none" | "scheduled" | "reconcile";
  label: string;
  dueAtMs: number | null;
  warning: boolean;
};

/** Classifies whether one provisioned object has a live owner that may receive application work. */
export function describeObjectStatus(
  object: ObjectControlOverview,
  nowEpochMs: number,
): ObjectStatus {
  if (!object.location) {
    return {
      kind: "not-provisioned",
      label: "Not provisioned",
      explanation:
        "No canonical object log exists yet. The first application request will provision it.",
      ownerNodeId: null,
      ownerProcessGeneration: null,
      ownerLeaseExpiresAtMs: null,
    };
  }
  const routingState = object.routingState;
  if (!routingState) {
    return {
      kind: "control-inconsistent",
      label: "Control mismatch",
      explanation: "The directory has a log, but its ownership record could not be resolved.",
      ownerNodeId: null,
      ownerProcessGeneration: null,
      ownerLeaseExpiresAtMs: null,
    };
  }
  if (routingState.kind === "unowned") {
    return {
      kind: "unowned",
      label: "Unowned",
      explanation: "Durable state exists, but no process currently owns this object.",
      ownerNodeId: null,
      ownerProcessGeneration: null,
      ownerLeaseExpiresAtMs: null,
    };
  }
  if (routingState.kind === "owned-without-node-lease") {
    return {
      kind: "owner-missing",
      label: "Owner missing",
      explanation:
        "Ownership names a node that no longer has a durable lease record. A live node may take over.",
      ownerNodeId: routingState.ownership.ownerNodeId,
      ownerProcessGeneration: null,
      ownerLeaseExpiresAtMs: null,
    };
  }
  const ownerLease = routingState.ownerLease;
  if (ownerLease.expiresAtMs <= nowEpochMs) {
    return {
      kind: "owner-expired",
      label: "Owner expired",
      explanation:
        "The recorded owner's lease has expired. The next eligible request or alarm scan may fence and take over.",
      ownerNodeId: routingState.ownership.ownerNodeId,
      ownerProcessGeneration: ownerLease.processGeneration,
      ownerLeaseExpiresAtMs: ownerLease.expiresAtMs,
    };
  }
  if (routingState.ownership.state === "restoring") {
    return {
      kind: "restoring",
      label: "Restoring",
      explanation:
        "The owner has claimed a new epoch and is fencing or initializing before application delivery.",
      ownerNodeId: routingState.ownership.ownerNodeId,
      ownerProcessGeneration: ownerLease.processGeneration,
      ownerLeaseExpiresAtMs: ownerLease.expiresAtMs,
    };
  }
  return {
    kind: "active",
    label: "Active",
    explanation: "The object is ready and its owner has a live node lease.",
    ownerNodeId: routingState.ownership.ownerNodeId,
    ownerProcessGeneration: ownerLease.processGeneration,
    ownerLeaseExpiresAtMs: ownerLease.expiresAtMs,
  };
}

/** Summarizes durable alarm discovery state without changing alarm ownership or delivery. */
export function describeObjectAlarmStatus(
  object: ObjectControlOverview,
  nowEpochMs: number,
): ObjectAlarmStatus {
  const alarmWork = object.alarmWork;
  if (!alarmWork) {
    return { kind: "none", label: "None", dueAtMs: null, warning: false };
  }
  if (alarmWork.kind === "reconcile") {
    return { kind: "reconcile", label: "Repair pending", dueAtMs: null, warning: true };
  }
  return {
    kind: "scheduled",
    label: alarmWork.dueAtMs <= nowEpochMs ? "Due now" : "Scheduled",
    dueAtMs: alarmWork.dueAtMs,
    warning: alarmWork.dueAtMs <= nowEpochMs,
  };
}
