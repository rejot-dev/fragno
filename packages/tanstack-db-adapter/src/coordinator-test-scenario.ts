import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnySchema } from "@fragno-dev/db/schema";
import Database from "better-sqlite3";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import {
  buildDatabaseFragmentsTest,
  createFragmentTestFetcher,
  type AnyFragmentResult,
} from "@fragno-dev/test";

import type { Collection } from "@tanstack/db";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import {
  createFragnoOutboxCoordinator,
  type FragnoCollectionRow,
  type FragnoOutboxCoordinator,
  type FragnoOutboxCoordinatorDependencies,
} from "./coordinator";

const TEST_BASE_URL = "http://tanstack-db-coordinator-behavior.test";

type TableName<TSchema extends AnySchema> = keyof TSchema["tables"] & string;
type ScenarioCollection<
  TSchema extends AnySchema,
  TTableName extends TableName<TSchema>,
> = Collection<FragnoCollectionRow<TSchema["tables"][TTableName]>, string>;

export type FromScratchTestScenario<
  TSchema extends AnySchema,
  TTableName extends TableName<TSchema>,
> = {
  server: AnyFragmentResult;
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  collection: ScenarioCollection<TSchema, TTableName>;
  coordinator: FragnoOutboxCoordinator<readonly [TSchema]>;
  readonly openedDatabaseNames: readonly string[];
  sync(): Promise<void>;
  reload(): Promise<void>;
  readPersistedRows(): Promise<
    Array<{ key: string | number; value: Record<string, unknown>; metadata?: unknown }>
  >;
};

export async function withFromScratchTestScenario<
  TSchema extends AnySchema,
  TTableName extends TableName<TSchema>,
>(options: {
  name: string;
  schema: TSchema;
  table: TTableName;
  databaseNamespace?: string | null;
  fetch?(serverFetch: typeof globalThis.fetch): typeof globalThis.fetch;
  run(scenario: FromScratchTestScenario<TSchema, TTableName>): Promise<void>;
}): Promise<void> {
  const fragmentDefinition = defineFragment(`tanstack-db-coordinator-${options.name}`)
    .extend(withDatabase(options.schema))
    .build();
  const fragmentBuilder = instantiate(fragmentDefinition)
    .withConfig({})
    .withRoutes([])
    .withOptions({
      mountRoute: "/coordinator",
      outbox: { enabled: true },
      ...(options.databaseNamespace === undefined
        ? {}
        : { databaseNamespace: options.databaseNamespace }),
    });
  const setup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment("server", fragmentBuilder)
    .build();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), `fragno-${options.name}-`));
  const databasePath = join(temporaryDirectory, "persistence.sqlite");
  const server = setup.fragments.server;
  const serverFetch = createFragmentTestFetcher(server.fragment, { baseUrl: TEST_BASE_URL });
  const fetch = options.fetch?.(serverFetch) ?? serverFetch;
  const baseUrl = new URL(server.fragment.mountRoute, TEST_BASE_URL).toString();
  let activePersistence: PersistedCollectionPersistence | undefined;
  const openedDatabaseNames: string[] = [];

  const dependencies = {
    async openPersistence({ databaseName }: { databaseName: string }) {
      openedDatabaseNames.push(databaseName);
      const database = new Database(databasePath);
      const persistence = createNodeSQLitePersistence({ database });
      activePersistence = persistence;
      return {
        persistence,
        async cleanup() {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
          database.close();
        },
      };
    },
  } satisfies FragnoOutboxCoordinatorDependencies;

  const openFrontend = async () => {
    const coordinator = await createFragnoOutboxCoordinator(
      { baseUrl, fetch, schemas: [options.schema] as const },
      dependencies,
    );
    const collection = coordinator.collection(options.schema, options.table);
    return { coordinator, collection };
  };

  let frontend = await openFrontend();

  const scenario: FromScratchTestScenario<TSchema, TTableName> = {
    server,
    fetch,
    baseUrl,
    get collection() {
      return frontend.collection;
    },
    get coordinator() {
      return frontend.coordinator;
    },
    openedDatabaseNames,
    async sync() {
      if (frontend.coordinator.state === "idle") {
        await frontend.coordinator.preload();
      }
      await waitForCurrentCheckpoint(frontend.coordinator, baseUrl, serverFetch);
    },
    async reload() {
      await frontend.coordinator.cleanup();
      frontend = await openFrontend();
      await frontend.coordinator.preload();
      await waitForCurrentCheckpoint(frontend.coordinator, baseUrl, serverFetch);
    },
    async readPersistedRows() {
      if (!activePersistence?.adapter.scanRows) {
        throw new Error("The test persistence adapter cannot scan rows.");
      }
      const namespace = options.schema.name.replaceAll("-", "_");
      const collectionId = `fragno.outbox.table.v1:${namespace.length}:${namespace}${options.table.length}:${options.table}`;
      return (await activePersistence.adapter.scanRows(collectionId)) as Array<{
        key: string | number;
        value: Record<string, unknown>;
        metadata?: unknown;
      }>;
    },
  };

  try {
    await options.run(scenario);
  } finally {
    await frontend.coordinator.cleanup().catch(() => {});
    await setup.test.cleanup();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function waitForCurrentCheckpoint(
  coordinator: FragnoOutboxCoordinator<readonly [AnySchema]>,
  baseUrl: string,
  fetch: typeof globalThis.fetch,
): Promise<void> {
  const response = await fetch(new URL("_internal", ensureTrailingSlash(baseUrl)));
  const description = (await response.json()) as { currentVersionstamp: string | null };

  await waitFor(() => {
    if (description.currentVersionstamp === null) {
      return coordinator.state === "live";
    }
    return coordinator.internal.getCheckpoint()?.versionstamp === description.currentVersionstamp;
  });
}

export async function waitFor(assertion: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the coordinator test scenario.");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
