import type { AnySchema } from "@fragno-dev/db/schema";
import Database from "better-sqlite3";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import {
  buildDatabaseFragmentsTest,
  createFragmentTestFetcher,
  type AnyFragmentResult,
} from "@fragno-dev/test";

import { createCollection, type Collection, type CollectionConfig } from "@tanstack/db";
import {
  createNodeSQLitePersistence,
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/node-db-sqlite-persistence";

import { FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY, type FragnoOutboxCheckpoint } from "./checkpoint";
import type { FragnoCollectionUtils } from "./collection-options";
import { createFragnoOutboxCoordinator, type FragnoOutboxCoordinator } from "./coordinator";
import type { FragnoCollectionRow, FragnoCollectionTarget } from "./protocol";
import { createFetchFragnoOutboxTransport } from "./transport";

const SCENARIO_BASE_URL = "http://tanstack-db-scenario.test";
const DEFAULT_PERSISTENCE_TIMEOUT_MS = 1_000;

type ScenarioTableName<TSchema extends AnySchema> = keyof TSchema["tables"] & string;
type ScenarioRow<
  TSchema extends AnySchema,
  TTableName extends ScenarioTableName<TSchema>,
> = FragnoCollectionRow<TSchema["tables"][TTableName]>;

type ScenarioCollection<
  TSchema extends AnySchema,
  TTableName extends ScenarioTableName<TSchema>,
> = Collection<ScenarioRow<TSchema, TTableName>, string, FragnoCollectionUtils>;

export type IngestScenarioCollectionOptionsFactory<
  TSchema extends AnySchema,
  TTableName extends ScenarioTableName<TSchema>,
> = (context: {
  id: string;
  coordinator: FragnoOutboxCoordinator;
  target: FragnoCollectionTarget<TSchema, TTableName>;
}) => CollectionConfig<ScenarioRow<TSchema, TTableName>, string, never, FragnoCollectionUtils>;

export type IngestScenarioCoordinatorFactory = (context: {
  internalUrl: string;
  fetch: typeof globalThis.fetch;
}) => FragnoOutboxCoordinator;

export type IngestScenarioDefinition<
  TSchema extends AnySchema,
  TTableName extends ScenarioTableName<TSchema>,
> = {
  name: string;
  schema: TSchema;
  table: TTableName;
  /** Physical namespace selected by the collection target. */
  namespace?: string | null;
  /** Physical namespace used by the instantiated Fragno database fragment. */
  databaseNamespace?: string | null;
  schemaVersion?: number;
  coordinator?: IngestScenarioCoordinatorFactory;
  collectionOptions: IngestScenarioCollectionOptionsFactory<TSchema, TTableName>;
  steps: IngestScenarioStep<TSchema, TTableName>[];
};

export type IngestScenarioContext<
  TSchema extends AnySchema,
  TTableName extends ScenarioTableName<TSchema>,
> = {
  name: string;
  server: {
    fragment: AnyFragmentResult;
    fetch: typeof globalThis.fetch;
    internalUrl: string;
  };
  frontend: {
    database: Database.Database;
    persistence: PersistedCollectionPersistence;
    collection: ScenarioCollection<TSchema, TTableName>;
    readPersistedRows(): Promise<
      Array<{
        key: string | number;
        value: Record<string, unknown>;
        metadata?: unknown;
      }>
    >;
    readPersistedMetadata(): Promise<Array<{ key: string; value: unknown }>>;
  };
  cleanup(): Promise<void>;
};

export type IngestScenarioStep<
  TSchema extends AnySchema,
  TTableName extends ScenarioTableName<TSchema>,
> =
  | {
      type: "server";
      run(context: IngestScenarioContext<TSchema, TTableName>): void | Promise<void>;
    }
  | { type: "ingest" }
  | { type: "reload" }
  | {
      type: "assert";
      run(context: IngestScenarioContext<TSchema, TTableName>): void | Promise<void>;
    };

export function defineIngestScenario<
  TSchema extends AnySchema,
  TTableName extends ScenarioTableName<TSchema>,
>(
  definition: IngestScenarioDefinition<TSchema, TTableName>,
): IngestScenarioDefinition<TSchema, TTableName> {
  return definition;
}

export function createIngestScenarioSteps<
  TSchema extends AnySchema,
  TTableName extends ScenarioTableName<TSchema>,
>() {
  return {
    server(
      run: (context: IngestScenarioContext<TSchema, TTableName>) => void | Promise<void>,
    ): IngestScenarioStep<TSchema, TTableName> {
      return { type: "server", run };
    },
    ingest(): IngestScenarioStep<TSchema, TTableName> {
      return { type: "ingest" };
    },
    reload(): IngestScenarioStep<TSchema, TTableName> {
      return { type: "reload" };
    },
    assert(
      run: (context: IngestScenarioContext<TSchema, TTableName>) => void | Promise<void>,
    ): IngestScenarioStep<TSchema, TTableName> {
      return { type: "assert", run };
    },
  };
}

export async function runIngestScenario<
  TSchema extends AnySchema,
  TTableName extends ScenarioTableName<TSchema>,
>(
  definition: IngestScenarioDefinition<TSchema, TTableName>,
): Promise<IngestScenarioContext<TSchema, TTableName>> {
  const fragmentDefinition = defineFragment(`tanstack-db-scenario-${definition.name}`)
    .extend(withDatabase(definition.schema))
    .build();
  const fragmentBuilder = instantiate(fragmentDefinition)
    .withConfig({})
    .withRoutes([])
    .withOptions({
      mountRoute: "/scenario",
      outbox: { enabled: true },
      ...(definition.databaseNamespace === undefined
        ? {}
        : { databaseNamespace: definition.databaseNamespace }),
    });
  const setup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment("server", fragmentBuilder)
    .build();

  const serverFragment = setup.fragments.server;
  const fetcher = createFragmentTestFetcher(serverFragment.fragment, {
    baseUrl: SCENARIO_BASE_URL,
  });
  const internalUrl = new URL(
    `${serverFragment.fragment.mountRoute}/_internal`,
    SCENARIO_BASE_URL,
  ).toString();
  const coordinator =
    definition.coordinator?.({ internalUrl, fetch: fetcher }) ??
    createFragnoOutboxCoordinator({
      internalUrl,
      transport: createFetchFragnoOutboxTransport({ internalUrl, fetch: fetcher }),
      // Scenarios synchronize explicitly so background polling cannot race their assertions.
      pollIntervalMs: 60_000,
    });
  const database = new Database(":memory:");
  const sharedPersistence = createNodeSQLitePersistence({ database });
  const collectionId = `scenario.${definition.name}.${definition.table}`;
  const target = {
    schema: definition.schema,
    table: definition.table,
    ...(definition.namespace === undefined ? {} : { namespace: definition.namespace }),
  } satisfies FragnoCollectionTarget<TSchema, TTableName>;

  const createFrontend = () => {
    const sourceOptions = definition.collectionOptions({
      id: collectionId,
      coordinator,
      target,
    });
    const persistedOptions = persistedCollectionOptions({
      ...sourceOptions,
      persistence: sharedPersistence,
      schemaVersion: definition.schemaVersion ?? 1,
    });

    // The persistence wrapper preserves the source row and utility contract, but its overload
    // widens an omitted Standard Schema. Re-establish the source contract at this package boundary.
    const collectionOptions = persistedOptions as unknown as CollectionConfig<
      ScenarioRow<TSchema, TTableName>,
      string,
      never,
      FragnoCollectionUtils
    >;

    return {
      collection: createCollection(collectionOptions) as ScenarioCollection<TSchema, TTableName>,
      persistence: persistedOptions.persistence,
    };
  };

  let frontend = createFrontend();
  const context: IngestScenarioContext<TSchema, TTableName> = {
    name: definition.name,
    server: {
      fragment: serverFragment,
      fetch: fetcher,
      internalUrl,
    },
    frontend: {
      database,
      persistence: frontend.persistence,
      collection: frontend.collection,
      async readPersistedRows() {
        const adapter = context.frontend.persistence.adapter;
        if (!adapter.scanRows) {
          throw new Error("The scenario persistence adapter does not support scanning rows.");
        }
        return (await adapter.scanRows(collectionId)) as Array<{
          key: string | number;
          value: Record<string, unknown>;
          metadata?: unknown;
        }>;
      },
      async readPersistedMetadata() {
        const adapter = context.frontend.persistence.adapter;
        if (!adapter.loadCollectionMetadata) {
          throw new Error("The scenario persistence adapter does not support collection metadata.");
        }
        return await adapter.loadCollectionMetadata(collectionId);
      },
    },
    async cleanup() {
      await context.frontend.collection.cleanup();
      coordinator.dispose();
      database.close();
      await setup.test.cleanup();
    },
  };

  try {
    for (const step of definition.steps) {
      if (step.type === "server" || step.type === "assert") {
        await step.run(context);
        continue;
      }

      if (step.type === "ingest") {
        if (context.frontend.collection.status === "idle") {
          await Promise.all([
            context.frontend.collection.preload(),
            context.frontend.collection.utils.initialSync(),
          ]);
        } else {
          await context.frontend.collection.utils.syncOnce();
        }
        await waitForPersistedCheckpoint(context.frontend, definition.name);
        continue;
      }

      await context.frontend.collection.cleanup();
      frontend = createFrontend();
      context.frontend.collection = frontend.collection;
      context.frontend.persistence = frontend.persistence;
      await Promise.all([
        context.frontend.collection.preload(),
        context.frontend.collection.utils.initialSync(),
      ]);
      await waitForPersistedCheckpoint(context.frontend, definition.name);
    }

    return context;
  } catch (error) {
    await context.cleanup();
    throw error;
  }
}

async function waitForPersistedCheckpoint<
  TSchema extends AnySchema,
  TTableName extends ScenarioTableName<TSchema>,
>(
  frontend: IngestScenarioContext<TSchema, TTableName>["frontend"],
  scenarioName: string,
): Promise<void> {
  const expectedCheckpoint = frontend.collection.utils.getCheckpoint();
  if (expectedCheckpoint === undefined) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= DEFAULT_PERSISTENCE_TIMEOUT_MS) {
    const metadata = await frontend.readPersistedMetadata();
    const persistedCheckpoint = metadata.find(
      ({ key }) => key === FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY,
    )?.value as FragnoOutboxCheckpoint | undefined;
    if (
      persistedCheckpoint?.versionstamp === expectedCheckpoint.versionstamp &&
      persistedCheckpoint.uowId === expectedCheckpoint.uowId
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  throw new Error(`Timed out waiting for frontend persistence in scenario ${scenarioName}.`);
}
