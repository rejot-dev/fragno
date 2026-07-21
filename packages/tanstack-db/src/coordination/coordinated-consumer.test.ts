import { assert, describe, expect, it, vi } from "vitest";

import type {
  PersistedCollectionCoordinator,
  PersistedIndexSpec,
  ProtocolEnvelope,
} from "@tanstack/db-sqlite-persistence-core";

import type { StreamConsumerMode } from "../consumer/durable-stream-consumer";
import { CoordinatedConsumerRuntime } from "./coordinated-consumer";

const createCoordinator = (options: { nodeId: string; leader: boolean }) => {
  let leader = options.leader;
  let listener: ((message: ProtocolEnvelope<unknown>) => void) | undefined;
  const published: ProtocolEnvelope<unknown>[] = [];

  const coordinator: PersistedCollectionCoordinator = {
    getNodeId: () => options.nodeId,
    subscribe: (_collectionId, nextListener) => {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    },
    publish: (_collectionId, message) => published.push(message),
    isLeader: () => leader,
    ensureLeadership: async () => {},
    requestEnsurePersistedIndex: async (
      _collectionId: string,
      _signature: string,
      _spec: PersistedIndexSpec,
    ) => {},
  };

  return {
    coordinator,
    published,
    setLeader(value: boolean) {
      leader = value;
    },
    send(message: ProtocolEnvelope<unknown>) {
      listener?.(message);
    },
    get subscribed() {
      return listener !== undefined;
    },
  };
};

describe("CoordinatedConsumerRuntime", () => {
  it("starts immediately without a coordinator", () => {
    const startedModes: StreamConsumerMode[] = [];
    const runtime = new CoordinatedConsumerRuntime({
      collectionId: "source",
      startConsumer: (mode) => {
        startedModes.push(mode);
        return true;
      },
      onMessage: () => {},
      onError: () => {},
    });

    runtime.request(false);

    assert(runtime.ownerId === "single-process");
    expect(startedModes).toEqual([false]);
    runtime.close();
  });

  it("waits for follower promotion before starting the requested consumer", () => {
    const testCoordinator = createCoordinator({ nodeId: "follower", leader: false });
    const startedModes: StreamConsumerMode[] = [];
    const runtime = new CoordinatedConsumerRuntime({
      coordinator: testCoordinator.coordinator,
      collectionId: "source",
      leadershipPollIntervalMs: 60_000,
      startConsumer: (mode) => {
        startedModes.push(mode);
        return true;
      },
      onMessage: () => {},
      onError: () => {},
    });

    runtime.request("long-poll");
    expect(startedModes).toEqual([]);
    assert(testCoordinator.subscribed);

    testCoordinator.setLeader(true);
    runtime.reevaluateLeadership();

    expect(startedModes).toEqual(["long-poll"]);
    runtime.close();
    assert(!testCoordinator.subscribed);
  });

  it("retains a finite request when the consumer is temporarily blocked", () => {
    let canStart = false;
    const startedModes: StreamConsumerMode[] = [];
    const runtime = new CoordinatedConsumerRuntime({
      collectionId: "source",
      startConsumer: (mode) => {
        if (!canStart) {
          return false;
        }
        startedModes.push(mode);
        return true;
      },
      onMessage: () => {},
      onError: () => {},
    });

    runtime.request(false);
    expect(startedModes).toEqual([]);

    canStart = true;
    runtime.reevaluateLeadership();
    expect(startedModes).toEqual([false]);
    runtime.reevaluateLeadership();
    expect(startedModes).toEqual([false]);
    runtime.close();
  });

  it("routes coordinator messages and publishes owner-scoped envelopes", async () => {
    const testCoordinator = createCoordinator({ nodeId: "leader", leader: true });
    const onMessage = vi.fn();
    const onError = vi.fn();
    const runtime = new CoordinatedConsumerRuntime({
      coordinator: testCoordinator.coordinator,
      collectionId: "source",
      leadershipPollIntervalMs: 60_000,
      startConsumer: () => true,
      onMessage,
      onError,
    });
    runtime.request("long-poll");

    const incoming: ProtocolEnvelope<unknown> = {
      v: 1,
      dbName: "source",
      collectionId: "source",
      senderId: "other",
      ts: 1,
      payload: { type: "leader:heartbeat", leaderId: "other" },
    };
    testCoordinator.send(incoming);
    await Promise.resolve();
    expect(onMessage).toHaveBeenCalledWith(incoming);
    expect(onError).not.toHaveBeenCalled();

    runtime.publish({ type: "terminal" });
    expect(testCoordinator.published).toEqual([
      expect.objectContaining({
        collectionId: "source",
        senderId: "leader",
        payload: { type: "terminal" },
      }),
    ]);
    runtime.close();
  });
});
