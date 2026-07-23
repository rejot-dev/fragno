import { createFragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";
import { createPersistedFragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter/persistence";
import { createFetchFragnoOutboxStreamingTransport } from "@fragno-dev/tanstack-db-adapter/streaming-transport";

import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { automationFragmentSchema } from "@/fragno/automation/schema";

import { automationScopeRouteId, toBackofficeScope, type AutomationUiScope } from "../scope";

const AUTOMATION_DATABASE_NAME = "fragno-backoffice-automations.sqlite";
const AUTOMATION_DATABASE_COORDINATOR_NAME = "fragno-backoffice-automations";
const AUTOMATION_COLLECTION_SCHEMA_VERSION = 2;

type AutomationPersistenceSource = {
  scope: AutomationUiScope;
  adapterIdentity: string;
};

type AutomationPersistenceSourceDescription = {
  resourceKey: string;
  internalUrl: string;
  collectionId(target: string): string;
};

type CreatePersistedCollection = ReturnType<typeof createPersistedFragnoCollectionFactory>;

export function describeAutomationPersistenceSource(
  source: AutomationPersistenceSource,
): AutomationPersistenceSourceDescription {
  const scopeKey = backofficeContextScopeSinglePathSegment(toBackofficeScope(source.scope));
  const internalUrl = `/api/automations-scoped/${source.scope.kind}/${encodeURIComponent(automationScopeRouteId(source.scope))}/_internal`;

  return {
    resourceKey: JSON.stringify([scopeKey, source.adapterIdentity]),
    internalUrl,
    collectionId: (target) =>
      JSON.stringify(["backoffice", "automations", scopeKey, source.adapterIdentity, target]),
  };
}

function createAutomationCollectionResource(
  source: AutomationPersistenceSource,
  createPersistedCollection: CreatePersistedCollection,
) {
  const description = describeAutomationPersistenceSource(source);
  const coordinator = createFragnoOutboxCoordinator({
    internalUrl: description.internalUrl,
    bootstrap: { adapterIdentity: source.adapterIdentity },
    transport: createFetchFragnoOutboxStreamingTransport({ internalUrl: description.internalUrl }),
  });
  const collections = {
    kvStore: createPersistedCollection({
      id: description.collectionId("kv_store"),
      coordinator,
      target: {
        schema: automationFragmentSchema,
        table: "kv_store",
      },
    }),
    sandboxInstances: createPersistedCollection({
      id: description.collectionId("sandbox_instance"),
      coordinator,
      target: {
        schema: automationFragmentSchema,
        table: "sandbox_instance",
      },
    }),
    routes: createPersistedCollection({
      id: description.collectionId("automation_route"),
      coordinator,
      target: {
        schema: automationFragmentSchema,
        table: "automation_route",
      },
    }),
    routeScheduleStates: createPersistedCollection({
      id: description.collectionId("automation_route_schedule_state"),
      coordinator,
      target: {
        schema: automationFragmentSchema,
        table: "automation_route_schedule_state",
      },
    }),
    events: createPersistedCollection({
      id: description.collectionId("automation_event"),
      coordinator,
      target: {
        schema: automationFragmentSchema,
        table: "automation_event",
      },
    }),
    eventDefinitions: createPersistedCollection({
      id: description.collectionId("automation_event_definition"),
      coordinator,
      target: {
        schema: automationFragmentSchema,
        table: "automation_event_definition",
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
  collectionsFor(source: AutomationPersistenceSource): AutomationTanStackCollections;
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
      const resourceKey = describeAutomationPersistenceSource(source).resourceKey;
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
