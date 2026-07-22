import { createFragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";
import { createPersistedFragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter/persistence";
import { createFetchFragnoOutboxStreamingTransport } from "@fragno-dev/tanstack-db-adapter/streaming-transport";

import { automationFragmentSchema } from "@/fragno/automation/schema";

const AUTOMATION_DATABASE_NAME = "fragno-backoffice-automations.sqlite";
const AUTOMATION_DATABASE_COORDINATOR_NAME = "fragno-backoffice-automations";
const AUTOMATION_COLLECTION_SCHEMA_VERSION = 1;

type CreatePersistedCollection = ReturnType<typeof createPersistedFragnoCollectionFactory>;

type AutomationCollectionSource = {
  scopeKey: string;
  internalUrl: string;
  adapterIdentity: string;
};

function createAutomationCollectionResource(
  source: AutomationCollectionSource,
  createPersistedCollection: CreatePersistedCollection,
) {
  const coordinator = createFragnoOutboxCoordinator({
    internalUrl: source.internalUrl,
    bootstrap: { adapterIdentity: source.adapterIdentity },
    transport: createFetchFragnoOutboxStreamingTransport({ internalUrl: source.internalUrl }),
  });
  const collections = {
    kvStore: createPersistedCollection({
      id: `backoffice.automations.${source.scopeKey}.${source.adapterIdentity}.kv_store`,
      coordinator,
      target: {
        schema: automationFragmentSchema,
        table: "kv_store",
      },
    }),
  };

  return { collections, coordinator };
}

export type AutomationTanStackCollections = ReturnType<
  typeof createAutomationCollectionResource
>["collections"];

type AutomationCollectionResource = ReturnType<typeof createAutomationCollectionResource>;

type AutomationTanStackDatabase = {
  collectionsFor(source: AutomationCollectionSource): AutomationTanStackCollections;
};

async function openAutomationTanStackDatabase(): Promise<AutomationTanStackDatabase> {
  const {
    BrowserCollectionCoordinator,
    createBrowserWASQLitePersistence,
    openBrowserWASQLiteOPFSDatabase,
  } = await import("@tanstack/browser-db-sqlite-persistence");
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: AUTOMATION_DATABASE_NAME,
  });
  const persistenceCoordinator = new BrowserCollectionCoordinator({
    dbName: AUTOMATION_DATABASE_COORDINATOR_NAME,
  });
  const persistence = createBrowserWASQLitePersistence({
    database,
    coordinator: persistenceCoordinator,
  });
  const createPersistedCollection = createPersistedFragnoCollectionFactory({
    persistence,
    schemaVersion: AUTOMATION_COLLECTION_SCHEMA_VERSION,
  });
  const resources = new Map<string, AutomationCollectionResource>();

  return {
    collectionsFor(source) {
      const resourceKey = JSON.stringify([
        source.scopeKey,
        source.internalUrl,
        source.adapterIdentity,
      ]);
      const existing = resources.get(resourceKey);
      if (existing) {
        return existing.collections;
      }

      const resource = createAutomationCollectionResource(source, createPersistedCollection);
      resources.set(resourceKey, resource);
      return resource.collections;
    },
  };
}

let automationTanStackDatabase: Promise<AutomationTanStackDatabase> | undefined;

export function getAutomationTanStackDatabase(): Promise<AutomationTanStackDatabase> {
  if (typeof window === "undefined") {
    throw new Error("The automation TanStack database is only available in the browser.");
  }

  automationTanStackDatabase ??= openAutomationTanStackDatabase().catch((error: unknown) => {
    automationTanStackDatabase = undefined;
    throw error;
  });
  return automationTanStackDatabase;
}
