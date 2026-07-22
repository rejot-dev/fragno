import { piSchema } from "@fragno-dev/pi-harness/schema";
import { createFragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";
import { createPersistedFragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter/persistence";
import { createFetchFragnoOutboxStreamingTransport } from "@fragno-dev/tanstack-db-adapter/streaming-transport";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { scopedPublicMountPath } from "@/fragno/scoped-public-fragment-routes";

const PI_DATABASE_NAME = "fragno-backoffice-pi.sqlite";
const PI_DATABASE_COORDINATOR_NAME = "fragno-backoffice-pi";
const PI_COLLECTION_SCHEMA_VERSION = 1;

type CreatePersistedCollection = ReturnType<typeof createPersistedFragnoCollectionFactory>;

export type PiPersistenceSource = {
  scope: BackofficeContextScope;
  adapterIdentity: string;
};

type PiPersistenceSourceDescription = {
  resourceKey: string;
  internalUrl: string;
  collectionId(target: string): string;
};

export function describePiPersistenceSource(
  source: PiPersistenceSource,
): PiPersistenceSourceDescription {
  const scopeKey = backofficeContextScopeSinglePathSegment(source.scope);
  const identity = [scopeKey, source.adapterIdentity];

  return {
    resourceKey: JSON.stringify(identity),
    internalUrl: `${scopedPublicMountPath({ publicPrefix: "/api/pi", scope: source.scope })}/_internal`,
    collectionId: (target) =>
      JSON.stringify(["backoffice", "pi", scopeKey, source.adapterIdentity, target]),
  };
}

function createPiCollectionResource(
  source: PiPersistenceSource,
  createPersistedCollection: CreatePersistedCollection,
) {
  const description = describePiPersistenceSource(source);
  const coordinator = createFragnoOutboxCoordinator({
    internalUrl: description.internalUrl,
    bootstrap: { adapterIdentity: source.adapterIdentity },
    transport: createFetchFragnoOutboxStreamingTransport({
      internalUrl: description.internalUrl,
    }),
  });
  const collections = {
    sessions: createPersistedCollection({
      id: description.collectionId("pi-harness.session"),
      coordinator,
      target: {
        schema: piSchema,
        table: "session",
      },
    }),
    workflowInstances: createPersistedCollection({
      id: description.collectionId("workflows.workflow_instance"),
      coordinator,
      target: {
        schema: workflowsSchema,
        table: "workflow_instance",
      },
    }),
    workflowSteps: createPersistedCollection({
      id: description.collectionId("workflows.workflow_step"),
      coordinator,
      target: {
        schema: workflowsSchema,
        table: "workflow_step",
      },
    }),
    workflowStepEmissions: createPersistedCollection({
      id: description.collectionId("workflows.workflow_step_emission"),
      coordinator,
      target: {
        schema: workflowsSchema,
        table: "workflow_step_emission",
      },
    }),
  };

  return { collections, coordinator };
}

type PiTanStackCollections = ReturnType<typeof createPiCollectionResource>["collections"];

type PiCollectionResource = ReturnType<typeof createPiCollectionResource>;

export function createPiPersistenceResourceRegistry<TResource>(
  createResource: (source: PiPersistenceSource) => TResource,
) {
  const resources = new Map<string, TResource>();

  return {
    resourceFor(source: PiPersistenceSource): TResource {
      const resourceKey = describePiPersistenceSource(source).resourceKey;
      const existing = resources.get(resourceKey);
      if (existing) {
        return existing;
      }

      const resource = createResource(source);
      resources.set(resourceKey, resource);
      return resource;
    },
  };
}

type PiTanStackDatabase = {
  collectionsFor(source: PiPersistenceSource): PiTanStackCollections;
};

async function openPiTanStackDatabase(): Promise<PiTanStackDatabase> {
  const {
    BrowserCollectionCoordinator,
    createBrowserWASQLitePersistence,
    openBrowserWASQLiteOPFSDatabase,
  } = await import("@tanstack/browser-db-sqlite-persistence");
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: PI_DATABASE_NAME,
  });
  const persistenceCoordinator = new BrowserCollectionCoordinator({
    dbName: PI_DATABASE_COORDINATOR_NAME,
  });
  const persistence = createBrowserWASQLitePersistence({
    database,
    coordinator: persistenceCoordinator,
  });
  const createPersistedCollection = createPersistedFragnoCollectionFactory({
    persistence,
    schemaVersion: PI_COLLECTION_SCHEMA_VERSION,
  });
  const resources = createPiPersistenceResourceRegistry<PiCollectionResource>((source) =>
    createPiCollectionResource(source, createPersistedCollection),
  );

  return {
    collectionsFor(source) {
      return resources.resourceFor(source).collections;
    },
  };
}

let piTanStackDatabase: Promise<PiTanStackDatabase> | undefined;

export function getPiTanStackDatabase(): Promise<PiTanStackDatabase> {
  if (typeof window === "undefined") {
    throw new Error("The Pi TanStack database is only available in the browser.");
  }

  piTanStackDatabase ??= openPiTanStackDatabase();
  return piTanStackDatabase;
}
