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
import type { BackofficeRuntimeServices } from "./runtime-services";

export type InMemoryBackofficeRuntime = {
  env: InMemoryBackofficeRuntimeEnv;
  objects: BackofficeObjectRegistry;
  adapters: BackofficeDatabaseAdapterFactory;
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
  const adapters = createInMemoryBackofficeDatabaseAdapters();
  let runtimeServices: BackofficeRuntimeServices;
  const getRuntimeServices = () => runtimeServices;
  const objectFactory = new InMemoryObjectFactory({
    env: options.env,
    getRuntimeServices,
    getAutomationFileSystem: options.getAutomationFileSystem,
    objectFactories: options.objectFactories,
  });
  const objects = createBackofficeObjectRegistry(objectFactory);

  runtimeServices = {
    objects,
    adapters,
    config: objectFactory.createRuntimeConfig(),
  };

  const drain = async () => {
    const maxIterations = options.maxDrainIterations ?? 100;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const hadPendingBefore = objectFactory.instances().some(({ state }) => state.hasPendingWork);
      const dueBefore = objectFactory
        .instances()
        .some(({ state }) => state.alarmTimestamp !== null && state.alarmTimestamp <= Date.now());

      await objectFactory.drainWaitUntil();
      await objectFactory.drainAlarms(1_000);
      await objectFactory.drainWaitUntil();

      const hasPendingAfter = objectFactory.instances().some(({ state }) => state.hasPendingWork);
      const dueAfter = objectFactory
        .instances()
        .some(({ state }) => state.alarmTimestamp !== null && state.alarmTimestamp <= Date.now());
      if (!hadPendingBefore && !dueBefore && !hasPendingAfter && !dueAfter) {
        return;
      }
    }

    throw new Error(
      `In-memory Backoffice runtime did not drain after ${maxIterations} iterations.`,
    );
  };

  return {
    env: objectFactory.env,
    objects,
    adapters,
    drain,
    drainAlarms: () => objectFactory.drainAlarms(),
    drainWaitUntil: () => objectFactory.drainWaitUntil(),
    async cleanup() {
      await drain();
      await adapters.cleanup();
    },
  };
};
