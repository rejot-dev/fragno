import { describe, expect, it, assert, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { BackofficeDatabaseAdapterFactory } from "./database-adapters";
import { defaultInMemoryBackofficeRuntimeEnv } from "./in-memory-runtime-env";
import { LocalObjectFactory } from "./local-object-factory";
import { createBackofficeObjectRegistry } from "./object-registry";
import type { BackofficeRuntimeServices } from "./runtime-services";

type NamedObjectStub = {
  name: string;
};

const createFactory = () => {
  const adapters: BackofficeDatabaseAdapterFactory = {
    createAdapter: () => {
      throw new Error("Database adapter is not used by this object-factory test.");
    },
    forScope: () => adapters,
  };

  return new LocalObjectFactory({
    runtimeEnv: defaultInMemoryBackofficeRuntimeEnv(),
    clearDurableHooks: async () => {},
    getRuntimeServices: () => ({ adapters }) as BackofficeRuntimeServices,
    objectFactories: {
      UPLOAD: ({ name }) => ({ name }),
    },
  });
};

function createVoidDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createClockDrainFactory(runDrain: (nowEpochMs: () => number) => Promise<void>) {
  const adapters: BackofficeDatabaseAdapterFactory = {
    createAdapter: () => {
      throw new Error("Database adapter is not used by this object-factory test.");
    },
    forScope: () => adapters,
  };

  return new LocalObjectFactory({
    runtimeEnv: defaultInMemoryBackofficeRuntimeEnv(),
    clearDurableHooks: async () => {},
    getRuntimeServices: () => ({ adapters }) as BackofficeRuntimeServices,
    objectFactories: {
      UPLOAD: ({ state, nowEpochMs }) => {
        state.setBackgroundDrain(async () => {
          await runDrain(nowEpochMs);
        });
        return {};
      },
    },
  });
}

describe("LocalObjectFactory", () => {
  it("uses canonical user scope names and reuses the same instance for the same address", () => {
    const factory = createFactory();
    const objects = createBackofficeObjectRegistry(factory);

    const first = objects.upload.forUser({ userId: "user-1" });
    const second = objects.upload.forUser({ userId: "user-1" });
    const otherUser = objects.upload.forUser({ userId: "user-2" });
    const firstCommands = first.commands as unknown as NamedObjectStub;
    const secondCommands = second.commands as unknown as NamedObjectStub;

    expect(firstCommands).toBe(secondCommands);
    assert(firstCommands.name === "UPLOAD:v1:user:user-1");
    expect(otherUser.commands).not.toBe(firstCommands);
  });

  it("uses canonical project scope names and keeps project instances separate", () => {
    const factory = createFactory();
    const objects = createBackofficeObjectRegistry(factory);

    const projectOne = objects.upload.forProject({
      orgId: "org-1",
      projectId: "project-1",
    }).commands as unknown as NamedObjectStub;
    const projectTwo = objects.upload.forProject({
      orgId: "org-1",
      projectId: "project-2",
    }).commands as unknown as NamedObjectStub;

    assert(projectOne.name === "UPLOAD:v1:project:org-1:project-1");
    assert(projectTwo.name === "UPLOAD:v1:project:org-1:project-2");
    expect(projectTwo).not.toBe(projectOne);
  });

  it("rejects addresses for a different binding", () => {
    const factory = createFactory();

    expect(() =>
      factory.get(
        { name: "AUTOMATIONS" },
        {
          binding: "AUTH",
          scope: { kind: "singleton" },
        },
      ),
    ).toThrow("does not match requested binding AUTOMATIONS");
  });

  it("runs background drains and alarms with an isolated logical clock", async () => {
    const observedTimes: number[] = [];
    const originalDateNow = Date.now;
    const wallTimeBeforeDrain = Date.now();
    const adapters: BackofficeDatabaseAdapterFactory = {
      createAdapter: () => {
        throw new Error("Database adapter is not used by this object-factory test.");
      },
      forScope: () => adapters,
    };
    const factory = new LocalObjectFactory({
      runtimeEnv: defaultInMemoryBackofficeRuntimeEnv(),
      clearDurableHooks: async () => {},
      getRuntimeServices: () => ({ adapters }) as BackofficeRuntimeServices,
      objectFactories: {
        UPLOAD: ({ state, nowEpochMs }) => {
          state.setBackgroundDrain(async () => {
            observedTimes.push(Date.now(), nowEpochMs());
          });
          return {
            async scheduleAlarm() {
              await state.storage.setAlarm(nowEpochMs());
            },
            async alarm() {
              observedTimes.push(Date.now(), nowEpochMs());
            },
          };
        },
      },
    });
    const object = factory.get<{ scheduleAlarm(): Promise<void> }>(
      { name: "UPLOAD" },
      { binding: "UPLOAD", scope: { kind: "org", orgId: "org-1" } },
    );
    const advancedTime = factory.advanceTime(2 * 60 * 60 * 1_000);

    await factory.drainBackground();
    await object.commands.scheduleAlarm();
    await factory.drainAlarms();

    const [backgroundDateNow, backgroundFactoryNow, alarmDateNow, alarmFactoryNow] = observedTimes;
    assert(backgroundFactoryNow >= advancedTime && backgroundFactoryNow < advancedTime + 60_000);
    assert(alarmFactoryNow >= advancedTime && alarmFactoryNow < advancedTime + 60_000);
    assert(backgroundDateNow >= wallTimeBeforeDrain && backgroundDateNow < advancedTime);
    assert(alarmDateNow >= wallTimeBeforeDrain && alarmDateNow < advancedTime);
    expect(Date.now).toBe(originalDateNow);
  });

  it("keeps concurrent runtime drain clocks isolated without replacing Date.now", async () => {
    const originalDateNow = Date.now;
    const firstDrainStarted = createVoidDeferred();
    const releaseFirstDrain = createVoidDeferred();
    const secondDrainStarted = createVoidDeferred();
    const releaseSecondDrain = createVoidDeferred();
    const firstObservedTimes: Array<[number, number]> = [];
    const secondObservedTimes: Array<[number, number]> = [];
    const firstFactory = createClockDrainFactory(async (nowEpochMs) => {
      firstObservedTimes.push([Date.now(), nowEpochMs()]);
      firstDrainStarted.resolve();
      await releaseFirstDrain.promise;
      firstObservedTimes.push([Date.now(), nowEpochMs()]);
    });
    const secondFactory = createClockDrainFactory(async (nowEpochMs) => {
      secondObservedTimes.push([Date.now(), nowEpochMs()]);
      secondDrainStarted.resolve();
      await releaseSecondDrain.promise;
      secondObservedTimes.push([Date.now(), nowEpochMs()]);
    });
    const address = { binding: "UPLOAD" as const, scope: { kind: "org" as const, orgId: "org-1" } };
    firstFactory.get({ name: "UPLOAD" }, address);
    secondFactory.get({ name: "UPLOAD" }, address);
    firstFactory.advanceTime(60_000);
    secondFactory.advanceTime(120_000);

    const firstDrain = firstFactory.drainBackground();
    await firstDrainStarted.promise;
    const secondDrain = secondFactory.drainBackground();

    try {
      await secondDrainStarted.promise;
      expect(firstObservedTimes).toHaveLength(1);
      expect(secondObservedTimes).toHaveLength(1);
      expect(Date.now).toBe(originalDateNow);

      releaseFirstDrain.resolve();
      releaseSecondDrain.resolve();
      await Promise.all([firstDrain, secondDrain]);
    } finally {
      releaseFirstDrain.resolve();
      releaseSecondDrain.resolve();
      await Promise.allSettled([firstDrain, secondDrain]);
    }

    expect(firstObservedTimes).toHaveLength(2);
    expect(secondObservedTimes).toHaveLength(2);
    expect(firstObservedTimes[0]?.[1]).toBe(firstObservedTimes[1]?.[1]);
    expect(secondObservedTimes[0]?.[1]).toBe(secondObservedTimes[1]?.[1]);
    for (const [dateNow, factoryNow] of firstObservedTimes) {
      assert(factoryNow - dateNow >= 50_000);
    }
    for (const [dateNow, factoryNow] of secondObservedTimes) {
      assert(factoryNow - dateNow >= 110_000);
    }
    expect(Date.now).toBe(originalDateNow);
  });
});
