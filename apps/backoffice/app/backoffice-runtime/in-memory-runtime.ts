import { defaultFragnoRuntime } from "@fragno-dev/core";

import type { MasterFileSystem } from "@/files";

import type { BackofficeDatabaseAdapterFactory } from "./database-adapters";
import { createInMemoryBackofficeDatabaseAdapters } from "./in-memory-database-adapters";
import {
  InMemoryObjectFactory,
  type InMemoryObjectFactoryOverrides,
} from "./in-memory-object-factory";
import type { InMemoryBackofficeRuntimeEnv } from "./in-memory-runtime-env";
import { createBackofficeObjectRegistry } from "./object-registry";
import type { BackofficeObjectRegistry } from "./object-registry";
import type { BackofficeRuntimeConfig, BackofficeRuntimeServices } from "./runtime-services";

export type InMemoryBackofficeRuntime = {
  env: InMemoryBackofficeRuntimeEnv;
  objects: BackofficeObjectRegistry;
  adapters: BackofficeDatabaseAdapterFactory;
  config: BackofficeRuntimeConfig;
  services: BackofficeRuntimeServices;
  now(): number;
  advanceTime(ms: number): number;
  drain(): Promise<void>;
  drainAlarms(): Promise<void>;
  drainWaitUntil(): Promise<void>;
  cleanup(): Promise<void>;
};

export type CreateInMemoryBackofficeRuntimeOptions = {
  env?: Partial<InMemoryBackofficeRuntimeEnv>;
  getAutomationFileSystem?: (input: {
    orgId?: string;
    purpose?: string;
  }) => Promise<MasterFileSystem>;
  objectFactories?: InMemoryObjectFactoryOverrides;
  maxDrainIterations?: number;
};

export const createInMemoryBackofficeRuntime = async (
  options: CreateInMemoryBackofficeRuntimeOptions = {},
): Promise<InMemoryBackofficeRuntime> => {
  let runtimeNow = () => Date.now();
  const adapters = createInMemoryBackofficeDatabaseAdapters({
    adapterOptions: {
      clock: {
        now: () => new Date(runtimeNow()),
      },
    },
  });
  let runtimeServices: BackofficeRuntimeServices;
  const getRuntimeServices = () => runtimeServices;
  const objectFactory = new InMemoryObjectFactory({
    env: options.env,
    getRuntimeServices,
    getAutomationFileSystem: options.getAutomationFileSystem,
    objectFactories: options.objectFactories,
  });
  runtimeNow = () => objectFactory.now();
  const objects = createBackofficeObjectRegistry(objectFactory);

  runtimeServices = {
    objects,
    adapters,
    config: objectFactory.createRuntimeConfig(),
    fragnoRuntime: {
      ...defaultFragnoRuntime,
      time: {
        now: () => new Date(objectFactory.now()),
      },
    },
  };

  const drain = async () => {
    const maxIterations = options.maxDrainIterations ?? 100;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const hadPendingBefore = objectFactory.instances().some(({ state }) => state.hasPendingWork);
      const dueBefore = objectFactory
        .instances()
        .some(
          ({ state }) =>
            state.alarmTimestamp !== null && state.alarmTimestamp <= objectFactory.now(),
        );

      await objectFactory.drainWaitUntil();
      await objectFactory.drainAlarms();
      await objectFactory.drainWaitUntil();

      const hasPendingAfter = objectFactory.instances().some(({ state }) => state.hasPendingWork);
      const dueAfter = objectFactory
        .instances()
        .some(
          ({ state }) =>
            state.alarmTimestamp !== null && state.alarmTimestamp <= objectFactory.now(),
        );
      if (!hadPendingBefore && !dueBefore && !hasPendingAfter && !dueAfter) {
        return;
      }
    }

    const pending = await Promise.all(
      objectFactory
        .instances()
        .filter(
          ({ state }) =>
            state.hasPendingWork ||
            (state.alarmTimestamp !== null && state.alarmTimestamp <= objectFactory.now()),
        )
        .map(async ({ name, state }) => ({
          name,
          hasPendingWork: state.hasPendingWork,
          alarmTimestamp: state.alarmTimestamp,
          now: objectFactory.now(),
          storageKeys: [...(await state.storage.list()).keys()],
        })),
    );

    throw new Error(
      `In-memory Backoffice runtime did not drain after ${maxIterations} iterations: ${JSON.stringify(
        pending,
      )}.`,
    );
  };

  return {
    env: objectFactory.env,
    objects,
    adapters,
    config: runtimeServices.config,
    services: runtimeServices,
    now: () => objectFactory.now(),
    advanceTime: (ms) => objectFactory.advanceTime(ms),
    drain,
    drainAlarms: () => objectFactory.drainAlarms(),
    drainWaitUntil: () => objectFactory.drainWaitUntil(),
    async cleanup() {
      await objectFactory.drainWaitUntil();
      await adapters.cleanup();
    },
  };
};
