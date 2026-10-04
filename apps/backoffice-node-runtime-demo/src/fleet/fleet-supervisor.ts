import { rm } from "node:fs/promises";
import path from "node:path";

import type {
  NodeDebugOverview,
  ObjectControlOverview,
} from "../inspection/object-control-overview";
import {
  describeObjectAlarmStatus,
  describeObjectStatus,
  type ObjectAlarmStatus,
  type ObjectStatus,
} from "../inspection/object-status";
import { DemoNodeProcess, type DemoNodeExit } from "./node-process";

const NODE_REQUEST_TIMEOUT_MS = 3_000;
const NODE_STOP_TIMEOUT_MS = 10_000;

type FleetNodeIdentity = {
  processId: number;
  applicationOrigin: string;
  internalOrigin: string;
  peerWebSocketAddress: string;
  nodeId: string;
  processGeneration: string;
};

type FleetNodeObservation =
  | {
      kind: "available";
      latencyMs: number;
      overview: NodeDebugOverview;
    }
  | { kind: "unavailable"; latencyMs: number; error: string };

/** One managed runtime node's process lifecycle and observed ownership. */
export type FleetNodeSnapshot =
  | {
      state: "starting";
      slot: string;
      cacheDirectory: string;
      ownedObjectIds: string[];
    }
  | {
      state: "serving";
      slot: string;
      cacheDirectory: string;
      identity: FleetNodeIdentity;
      observation: FleetNodeObservation;
      ownedObjectIds: string[];
    }
  | {
      state: "stopping";
      slot: string;
      cacheDirectory: string;
      identity: FleetNodeIdentity;
      ownedObjectIds: string[];
    }
  | {
      state: "stopped" | "crashed";
      slot: string;
      cacheDirectory: string;
      lastIdentity: FleetNodeIdentity | null;
      reason: string;
      ownedObjectIds: string[];
    };

/** Correlates durable ownership with the local fleet without assuming every owner is managed. */
export type FleetObjectOwner =
  | { kind: "none" }
  | { kind: "managed"; slot: string; nodeId: string }
  | { kind: "external"; nodeId: string };

/** Object status and observation agreement across independently queried runtime nodes. */
export type FleetObjectSnapshot = {
  objectId: string;
  name: string;
  status: ObjectStatus;
  alarm: ObjectAlarmStatus;
  owner: FleetObjectOwner;
  ownershipEpoch: string | null;
  ownershipState: string | null;
  remoteLogId: string | null;
  observationsAgree: boolean;
  observationCount: number;
};

/** One fan-out observation of all managed nodes and their shared object directory. */
export type FleetSnapshot = {
  generatedAtMs: number;
  nodes: FleetNodeSnapshot[];
  objects: FleetObjectSnapshot[];
};

/** A request forwarded by the fleet app to one exact managed node ingress. */
export type FleetForwardedRequest = {
  ingress: "application" | "internal";
  method: "GET" | "POST";
  path: string;
  body: unknown;
};

/** The response from one exact node, preserving JSON or text without interpreting application data. */
export type FleetForwardedResponse = {
  nodeSlot: string;
  nodeId: string;
  status: number;
  elapsedMs: number;
  contentType: string;
  body: { kind: "json"; value: unknown } | { kind: "text"; value: string };
};

/** Lifecycle operations exposed by the local fleet debugging UI. */
export type FleetLifecycleAction = "stop" | "crash" | "restart" | "delete-cache-and-restart";

type FleetSupervisorOptions = {
  dataDirectory: string;
  nodeCount: number;
  peerAuthenticationSecret: string;
  alarmIntervalMs: number;
  leaseDurationMs: number;
};

type FleetNodeSlot = {
  slot: string;
  cacheDirectory: string;
  lifecycle: FleetNodeLifecycle;
};

type FleetNodeLifecycle =
  | { state: "starting" }
  | { state: "serving"; process: DemoNodeProcess }
  | { state: "stopping"; process: DemoNodeProcess; requested: "stop" | "crash" }
  | {
      state: "stopped" | "crashed";
      lastIdentity: FleetNodeIdentity | null;
      reason: string;
    };

/** Starts, observes, targets, and terminates the child runtime nodes managed by the fleet app. */
export class FleetSupervisor {
  readonly #options: FleetSupervisorOptions;
  readonly #slots: FleetNodeSlot[];
  #lifecycleQueue: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(options: FleetSupervisorOptions) {
    this.#options = options;
    this.#slots = Array.from({ length: options.nodeCount }, (_, index) => {
      const slot = `node-${index + 1}`;
      return {
        slot,
        cacheDirectory: path.join(options.dataDirectory, "cache", slot),
        lifecycle: {
          state: "stopped",
          lastIdentity: null,
          reason: "not started",
        },
      };
    });
  }

  /** Starts every configured node before returning the serving fleet supervisor. */
  static async start(options: FleetSupervisorOptions): Promise<FleetSupervisor> {
    const supervisor = new FleetSupervisor(options);
    try {
      await Promise.all(supervisor.#slots.map((slot) => supervisor.#startNode(slot)));
      return supervisor;
    } catch (error) {
      await supervisor.close();
      throw error;
    }
  }

  /** Reads every node independently, then correlates durable ownership with managed process slots. */
  async readFleetSnapshot(): Promise<FleetSnapshot> {
    const generatedAtMs = Date.now();
    const observations = new Map<string, FleetNodeObservation>();
    await Promise.all(
      this.#slots.map(async (slot) => {
        if (slot.lifecycle.state !== "serving") {
          return;
        }
        observations.set(slot.slot, await readNodeObservation(slot.lifecycle.process));
      }),
    );

    const servingNodeSlots = new Map<string, string>();
    for (const slot of this.#slots) {
      if (slot.lifecycle.state === "serving") {
        servingNodeSlots.set(slot.lifecycle.process.nodeId, slot.slot);
      }
    }

    const availableOverviews = this.#slots.flatMap((slot) => {
      const observation = observations.get(slot.slot);
      return observation?.kind === "available" ? [observation.overview] : [];
    });
    const objectIds = new Set(
      availableOverviews.flatMap((overview) => overview.objects.map((object) => object.objectId)),
    );
    const objects = [...objectIds].sort().map((objectId) => {
      const observedObjects = availableOverviews.flatMap((overview) => {
        const object = overview.objects.find((candidate) => candidate.objectId === objectId);
        return object ? [object] : [];
      });
      return createFleetObjectSnapshot(
        objectId,
        observedObjects,
        availableOverviews.length,
        servingNodeSlots,
        generatedAtMs,
      );
    });
    const ownedObjectIdsBySlot = new Map<string, string[]>();
    for (const object of objects) {
      if (object.owner.kind === "managed" && object.status.kind === "active") {
        const ownedObjectIds = ownedObjectIdsBySlot.get(object.owner.slot) ?? [];
        ownedObjectIds.push(object.objectId);
        ownedObjectIdsBySlot.set(object.owner.slot, ownedObjectIds);
      }
    }

    return {
      generatedAtMs,
      nodes: this.#slots.map((slot) =>
        createFleetNodeSnapshot(
          slot,
          observations.get(slot.slot) ?? null,
          ownedObjectIdsBySlot.get(slot.slot) ?? [],
        ),
      ),
      objects,
    };
  }

  /** Forwards one relative demo request to the exact selected node process. */
  async forwardRequest(
    slotName: string,
    request: FleetForwardedRequest,
  ): Promise<FleetForwardedResponse> {
    const slot = this.#requireNodeSlot(slotName);
    if (slot.lifecycle.state !== "serving") {
      throw new Error(`DEMO_FLEET_NODE_NOT_SERVING:${slotName}`);
    }
    const process = slot.lifecycle.process;
    const startedAtMs = Date.now();
    const origin =
      request.ingress === "application" ? process.applicationOrigin : process.internalOrigin;
    const response = await fetch(new URL(request.path, origin), {
      method: request.method,
      headers: request.body === null ? undefined : { "content-type": "application/json" },
      body: request.body === null ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(NODE_REQUEST_TIMEOUT_MS),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    return {
      nodeSlot: slot.slot,
      nodeId: process.nodeId,
      status: response.status,
      elapsedMs: Date.now() - startedAtMs,
      contentType,
      body: contentType.includes("application/json")
        ? { kind: "json", value: JSON.parse(text) as unknown }
        : { kind: "text", value: text },
    };
  }

  /** Applies one serialized lifecycle action to an exact managed node slot. */
  async changeNodeLifecycle(slotName: string, action: FleetLifecycleAction): Promise<void> {
    const operation = this.#lifecycleQueue.then(async () => {
      if (this.#closed) {
        throw new Error("DEMO_FLEET_SUPERVISOR_CLOSED");
      }
      const slot = this.#requireNodeSlot(slotName);
      if (action === "stop") {
        await this.#stopNode(slot, "stop");
        return;
      }
      if (action === "crash") {
        await this.#stopNode(slot, "crash");
        return;
      }
      if (slot.lifecycle.state === "serving") {
        await this.#stopNode(slot, "stop");
      }
      if (action === "delete-cache-and-restart") {
        await rm(slot.cacheDirectory, { recursive: true, force: true });
      }
      await this.#startNode(slot);
    });
    this.#lifecycleQueue = operation.catch(() => undefined);
    await operation;
  }

  /** Gracefully stops every live node, then hard-kills only nodes that exceed the deadline. */
  async close(): Promise<void> {
    if (this.#closed) {
      await this.#lifecycleQueue;
      return;
    }
    this.#closed = true;
    await this.#lifecycleQueue;
    await Promise.all(
      this.#slots.map(async (slot) => {
        if (slot.lifecycle.state !== "serving") {
          return;
        }
        const nodeProcess = slot.lifecycle.process;
        try {
          await this.#stopNode(slot, "stop");
        } catch (error) {
          console.error("DEMO_FLEET_NODE_GRACEFUL_STOP_FAILED", error);
          await nodeProcess.crash();
        }
      }),
    );
  }

  async #startNode(slot: FleetNodeSlot): Promise<void> {
    slot.lifecycle = { state: "starting" };
    try {
      const nodeProcess = await DemoNodeProcess.start({
        environment: process.env,
        slot: slot.slot,
        dataDirectory: this.#options.dataDirectory,
        cacheDirectory: slot.cacheDirectory,
        peerAuthenticationSecret: this.#options.peerAuthenticationSecret,
        alarmIntervalMs: this.#options.alarmIntervalMs,
        leaseDurationMs: this.#options.leaseDurationMs,
      });
      slot.lifecycle = { state: "serving", process: nodeProcess };
      void nodeProcess.exit.then((exit) => {
        this.#recordNodeExit(slot, nodeProcess, exit);
      });
    } catch (error) {
      slot.lifecycle = {
        state: "crashed",
        lastIdentity: null,
        reason: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async #stopNode(slot: FleetNodeSlot, requested: "stop" | "crash"): Promise<void> {
    if (slot.lifecycle.state !== "serving") {
      throw new Error(`DEMO_FLEET_NODE_NOT_SERVING:${slot.slot}`);
    }
    const nodeProcess = slot.lifecycle.process;
    slot.lifecycle = { state: "stopping", process: nodeProcess, requested };
    if (requested === "crash") {
      await nodeProcess.crash();
      slot.lifecycle = {
        state: "crashed",
        lastIdentity: readNodeProcessIdentity(nodeProcess),
        reason: "SIGKILL requested by fleet supervisor",
      };
      return;
    }
    try {
      await nodeProcess.stop(NODE_STOP_TIMEOUT_MS);
      slot.lifecycle = {
        state: "stopped",
        lastIdentity: readNodeProcessIdentity(nodeProcess),
        reason: "graceful stop requested by fleet supervisor",
      };
    } catch (error) {
      await nodeProcess.crash();
      slot.lifecycle = {
        state: "crashed",
        lastIdentity: readNodeProcessIdentity(nodeProcess),
        reason: "graceful stop exceeded its deadline and required SIGKILL",
      };
      throw error;
    }
  }

  #recordNodeExit(slot: FleetNodeSlot, nodeProcess: DemoNodeProcess, exit: DemoNodeExit): void {
    if (
      (slot.lifecycle.state === "serving" || slot.lifecycle.state === "stopping") &&
      slot.lifecycle.process === nodeProcess
    ) {
      const expectedStop =
        slot.lifecycle.state === "stopping" && slot.lifecycle.requested === "stop";
      slot.lifecycle = {
        state: expectedStop ? "stopped" : "crashed",
        lastIdentity: readNodeProcessIdentity(nodeProcess),
        reason: `process exited with code ${String(exit.code)} and signal ${String(exit.signal)}`,
      };
    }
  }

  #requireNodeSlot(slotName: string): FleetNodeSlot {
    const slot = this.#slots.find((candidate) => candidate.slot === slotName);
    if (!slot) {
      throw new Error(`DEMO_FLEET_NODE_UNKNOWN:${slotName}`);
    }
    return slot;
  }
}

async function readNodeObservation(process: DemoNodeProcess): Promise<FleetNodeObservation> {
  const startedAtMs = Date.now();
  try {
    const response = await fetch(new URL("/debug/overview", process.internalOrigin), {
      signal: AbortSignal.timeout(NODE_REQUEST_TIMEOUT_MS),
    });
    const value = (await response.json()) as NodeDebugOverview;
    if (!response.ok || value.nodeId !== process.nodeId || !Array.isArray(value.objects)) {
      throw new Error(`DEMO_NODE_OVERVIEW_INVALID:${process.slot}`);
    }
    return { kind: "available", latencyMs: Date.now() - startedAtMs, overview: value };
  } catch (error) {
    return {
      kind: "unavailable",
      latencyMs: Date.now() - startedAtMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createFleetObjectSnapshot(
  objectId: string,
  observedObjects: ObjectControlOverview[],
  availableNodeCount: number,
  servingNodeSlots: Map<string, string>,
  generatedAtMs: number,
): FleetObjectSnapshot {
  const object = observedObjects[0];
  if (!object) {
    throw new Error(`DEMO_FLEET_OBJECT_OBSERVATION_MISSING:${objectId}`);
  }
  const status = describeObjectStatus(object, generatedAtMs);
  const ownerNodeId = status.ownerNodeId;
  const managedOwnerSlot = ownerNodeId ? servingNodeSlots.get(ownerNodeId) : undefined;
  const owner: FleetObjectOwner = !ownerNodeId
    ? { kind: "none" }
    : managedOwnerSlot
      ? { kind: "managed", slot: managedOwnerSlot, nodeId: ownerNodeId }
      : { kind: "external", nodeId: ownerNodeId };
  const ownership = object.routingState?.ownership ?? null;
  const serializedObservation = JSON.stringify(object);
  return {
    objectId,
    name: objectId.startsWith("SHOWCASE:") ? objectId.slice("SHOWCASE:".length) : objectId,
    status,
    alarm: describeObjectAlarmStatus(object, generatedAtMs),
    owner,
    ownershipEpoch: ownership?.epoch ?? null,
    ownershipState: ownership?.state ?? null,
    remoteLogId: object.location?.remoteLogId ?? null,
    observationsAgree:
      observedObjects.length === availableNodeCount &&
      observedObjects.every((candidate) => JSON.stringify(candidate) === serializedObservation),
    observationCount: observedObjects.length,
  };
}

function createFleetNodeSnapshot(
  slot: FleetNodeSlot,
  observation: FleetNodeObservation | null,
  ownedObjectIds: string[],
): FleetNodeSnapshot {
  if (slot.lifecycle.state === "starting") {
    return {
      state: "starting",
      slot: slot.slot,
      cacheDirectory: slot.cacheDirectory,
      ownedObjectIds,
    };
  }
  if (slot.lifecycle.state === "serving") {
    return {
      state: "serving",
      slot: slot.slot,
      cacheDirectory: slot.cacheDirectory,
      identity: readNodeProcessIdentity(slot.lifecycle.process),
      observation: observation ?? {
        kind: "unavailable",
        latencyMs: 0,
        error: "observation not collected",
      },
      ownedObjectIds,
    };
  }
  if (slot.lifecycle.state === "stopping") {
    return {
      state: "stopping",
      slot: slot.slot,
      cacheDirectory: slot.cacheDirectory,
      identity: readNodeProcessIdentity(slot.lifecycle.process),
      ownedObjectIds,
    };
  }
  return {
    state: slot.lifecycle.state,
    slot: slot.slot,
    cacheDirectory: slot.cacheDirectory,
    lastIdentity: slot.lifecycle.lastIdentity,
    reason: slot.lifecycle.reason,
    ownedObjectIds,
  };
}

function readNodeProcessIdentity(process: DemoNodeProcess): FleetNodeIdentity {
  return {
    processId: process.processId,
    applicationOrigin: process.applicationOrigin,
    internalOrigin: process.internalOrigin,
    peerWebSocketAddress: process.peerWebSocketAddress,
    nodeId: process.nodeId,
    processGeneration: process.processGeneration,
  };
}
