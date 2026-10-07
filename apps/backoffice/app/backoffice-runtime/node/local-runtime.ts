import type { WorkerTypeChecker } from "@fragno-dev/codemode/compiler/compile-worker";

import { defaultFragnoRuntime } from "@fragno-dev/core";

import { createAppInstallationAuthorityResolver } from "@/fragno/app-installations/authority";
import { createAutomationRouteAuthorityResolver } from "@/fragno/automation/authority";
import type { AutomationSourceReader } from "@/fragno/automation/automation-source";
import type { PiAvailableModel } from "@/fragno/pi-manager/pi-agent-contract";
import type { CreateSandboxRuntimeProviders } from "@/sandbox/contracts";

import {
  createBackofficeAuthorityResolver,
  type BackofficeAuthorityResolver,
} from "../authority-resolver";
import type { BackofficeRuntimeEnv } from "../backoffice-runtime-env";
import type { BackofficeDatabaseAdapterFactory } from "../database-adapters";
import { createInMemoryBackofficeDatabaseAdapters } from "../in-memory-database-adapters";
import { noopBackofficeKernelObserver, type BackofficeKernelObserver } from "../kernel";
import { LocalObjectFactory, type LocalObjectFactoryOverrides } from "../local-object-factory";
import { createBackofficeObjectRegistry } from "../object-registry";
import type { BackofficeObjectAddress, BackofficeObjectRegistry } from "../object-registry";
import type {
  BackofficeFragmentHostOperations,
  BackofficeRuntimeConfig,
  BackofficeRuntimeServices,
} from "../runtime-services";
import { createSqliteBackofficeDatabaseAdapters } from "./sqlite-database-adapters";
import { SqliteBackofficeObjectStorage } from "./sqlite-object-storage";

export type LocalBackofficeRuntime = {
  env: BackofficeRuntimeEnv;
  objects: BackofficeObjectRegistry;
  adapters: BackofficeDatabaseAdapterFactory;
  config: BackofficeRuntimeConfig;
  services: BackofficeRuntimeServices;
  now(): number;
  advanceTime(ms: number): number;
  drain(): Promise<void>;
  discoverPersistedObjects(): Promise<void>;
  drainAlarms(): Promise<void>;
  drainWaitUntil(): Promise<void>;
  hasObjectInstance(address: BackofficeObjectAddress): boolean;
  restartObject(address: BackofficeObjectAddress): Promise<void>;
  cleanup(): Promise<void>;
};

export type LocalBackofficeDurableHooks = {
  createFragmentHostOperations(objectId: string): BackofficeFragmentHostOperations | null;
  unregisterObject(objectId: string): Promise<void>;
  cleanup(): Promise<void>;
};

export type CreateLocalBackofficeRuntimeOptions = {
  runtimeEnv: BackofficeRuntimeEnv;
  readAutomationSource?: AutomationSourceReader;
  objectFactories?: LocalObjectFactoryOverrides;
  piAvailableModels?: readonly PiAvailableModel[];
  createSandboxProviders?: CreateSandboxRuntimeProviders;
  authorityResolver?: BackofficeAuthorityResolver;
  kernelObserver?: BackofficeKernelObserver;
  workerTypeChecker?: WorkerTypeChecker;
  maxDrainIterations?: number;
  durableHooks?: LocalBackofficeDurableHooks;
  /** Enables file-backed SQLite object storage, auth and Fragment databases for a Node process. */
  sqliteDataDirectory?: string;
};

/** Creates the local object runtime used by Node production and in-process tests. */
export async function createLocalBackofficeRuntime(
  options: CreateLocalBackofficeRuntimeOptions,
): Promise<LocalBackofficeRuntime> {
  let runtimeServices: BackofficeRuntimeServices;
  const getRuntimeServices = () => runtimeServices;
  const sqliteStorage = options.sqliteDataDirectory
    ? new SqliteBackofficeObjectStorage(options.sqliteDataDirectory)
    : null;
  const objectFactory = new LocalObjectFactory({
    sqlite:
      sqliteStorage && options.sqliteDataDirectory
        ? { directory: options.sqliteDataDirectory, storage: sqliteStorage }
        : undefined,
    runtimeEnv: options.runtimeEnv,
    getRuntimeServices,
    createFragmentHostOperations: (objectId) =>
      options.durableHooks?.createFragmentHostOperations(objectId) ?? null,
    clearDurableHooks: async (objectId) => {
      await options.durableHooks?.unregisterObject(objectId);
    },
    readAutomationSource: options.readAutomationSource,
    objectFactories: options.objectFactories,
    piAvailableModels: options.piAvailableModels,
    createSandboxProviders: options.createSandboxProviders,
  });
  const config = objectFactory.createRuntimeConfig();
  const adapters = options.sqliteDataDirectory
    ? createSqliteBackofficeDatabaseAdapters(options.sqliteDataDirectory)
    : createInMemoryBackofficeDatabaseAdapters({
        adapterOptions: {
          clock: { now: () => new Date(objectFactory.now()) },
        },
      });
  const objects = createBackofficeObjectRegistry(objectFactory);

  runtimeServices = {
    objects,
    adapters,
    config,
    authorityResolver:
      options.authorityResolver ??
      createAppInstallationAuthorityResolver({
        resolver: createAutomationRouteAuthorityResolver({
          fallbackResolver: createBackofficeAuthorityResolver(
            {
              getUserAuthorityFacts: async (input) =>
                await objects.auth.singleton().commands.getUserAuthorityFacts(input),
            },
            { now: () => objectFactory.now() },
          ),
          lookupRoute: async ({ scope, routeId }) =>
            await objects.automations.for(scope).commands.getRouteForAuthority({ id: routeId }),
        }),
        auth: {
          getUserOrganizationAuthorityFacts: async (input) =>
            await objects.auth.singleton().commands.getUserOrganizationAuthorityFacts(input),
        },
      }),
    kernelObserver: options.kernelObserver ?? noopBackofficeKernelObserver,
    codemodeEnv: options.runtimeEnv.codemode,
    workerTypeChecker: options.workerTypeChecker ?? null,
    fragnoRuntime: {
      ...defaultFragnoRuntime,
      time: {
        now: () => new Date(objectFactory.now()),
      },
    },
  };

  await objectFactory.restorePersistedInstances();

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
      await objectFactory.drainBackground();
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
      `Local Backoffice runtime did not drain after ${maxIterations} iterations: ${JSON.stringify(
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
    discoverPersistedObjects: () => objectFactory.discoverPersistedInstances(),
    drainAlarms: () => objectFactory.drainAlarms(),
    drainWaitUntil: () => objectFactory.drainWaitUntil(),
    hasObjectInstance: (address) => objectFactory.hasInstance(address),
    restartObject: (address) => objectFactory.restart(address),
    async cleanup() {
      const failures: Array<{ step: string; cause: unknown }> = [];
      async function runCleanupStep(step: string, cleanup: () => void | Promise<void>) {
        try {
          await cleanup();
        } catch (cause) {
          failures.push({ step, cause });
        }
      }

      await runCleanupStep("waitUntil drain", async () => objectFactory.drainWaitUntil());
      await runCleanupStep("durable hooks", async () => options.durableHooks?.cleanup());
      await runCleanupStep("object factory", async () => objectFactory.cleanup());
      await runCleanupStep("database adapters", async () => adapters.cleanup());
      await runCleanupStep("object storage", () => sqliteStorage?.close());

      const [failure] = failures;
      if (failures.length === 1 && failure) {
        throw failure.cause;
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures.map(
            ({ step, cause }) =>
              new Error(`Node Backoffice runtime cleanup failed during ${step}.`, { cause }),
          ),
          "Multiple Node Backoffice runtime cleanup steps failed.",
        );
      }
    },
  };
}
