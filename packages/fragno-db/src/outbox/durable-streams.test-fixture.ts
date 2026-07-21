import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { KyselyPGlite } from "kysely-pglite";
import { SQLocalKysely } from "sqlocal/kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { toNodeHandler } from "@fragno-dev/node";

import { PGlite } from "@electric-sql/pglite";

import { PGLiteDriverConfig, SQLocalDriverConfig } from "../adapters/generic-sql/driver-config";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { InMemoryAdapter } from "../adapters/in-memory";
import { internalSchema } from "../fragments/internal-fragment";
import { getInternalFragment } from "../internal/adapter-registry";
import type { DatabaseRequestContext } from "../mod";
import type { AnySchema } from "../schema/create";
import { column, FragnoReference, idColumn, referenceColumn, schema } from "../schema/create";
import { withDatabase } from "../with-database";
import { DURABLE_STREAM_ZERO_OFFSET } from "./durable-streams";
import type { OutboxEntry } from "./outbox";

export const DURABLE_STREAMS_TEST_ZERO_OFFSET = DURABLE_STREAM_ZERO_OFFSET;

const alphaSchema = schema("durable_streams_alpha", (s) =>
  s
    .addTable("items", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("recordedAt", column("timestamp")),
    )
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .createIndex("idx_users_email", ["email"], { unique: true }),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("title", column("string")),
    ),
);

const betaSchema = schema("durable_streams_beta", (s) =>
  s.addTable("items", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const alphaFragmentDefinition = defineFragment("durable-streams-alpha-test")
  .extend(withDatabase(alphaSchema))
  .build();

const betaFragmentDefinition = defineFragment("durable-streams-beta-test")
  .extend(withDatabase(betaSchema))
  .build();

export type DurableStreamsFixtureAdapter = "in-memory" | "kysely-sqlite" | "kysely-pglite";

export type DurableStreamsReadFixture = {
  streamUrl: string;
  streamUrlFor: (schemaOrNamespace: string) => string;
  appendTargetMutation: (name?: string) => Promise<OutboxEntry>;
  appendUnrelatedMutation: (name?: string) => Promise<OutboxEntry>;
  appendMixedMutation: () => Promise<OutboxEntry>;
  appendReferenceMutation: () => Promise<OutboxEntry>;
  appendTargetMutationsConcurrently: (count: number) => Promise<OutboxEntry[]>;
  listOutboxEntries: (afterVersionstamp?: string) => Promise<OutboxEntry[]>;
  waitForRequestAbort: () => Promise<void>;
  close: () => Promise<void>;
};

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function migrateSchema(
  adapter: SqlAdapter,
  schemaToMigrate: AnySchema,
  namespace: string | null,
): Promise<void> {
  const migrations = adapter.prepareMigrations(schemaToMigrate, namespace);
  await migrations.executeWithDriver(adapter.driver, 0);
}

async function createAdapter(options: {
  type: DurableStreamsFixtureAdapter;
  targetNamespace: string | null;
  pgliteDataDir?: string;
  skipMigrations?: boolean;
}): Promise<InMemoryAdapter | SqlAdapter> {
  if (options.type === "in-memory") {
    return new InMemoryAdapter({ idSeed: crypto.randomUUID() });
  }

  let adapter: SqlAdapter;
  if (options.type === "kysely-sqlite") {
    const { dialect } = new SQLocalKysely(":memory:");
    adapter = new SqlAdapter({ dialect, driverConfig: new SQLocalDriverConfig() });
  } else {
    const { dialect } = new KyselyPGlite(new PGlite(options.pgliteDataDir));
    adapter = new SqlAdapter({ dialect, driverConfig: new PGLiteDriverConfig() });
  }

  if (!options.skipMigrations) {
    await migrateSchema(adapter, internalSchema, "");
    await migrateSchema(adapter, alphaSchema, options.targetNamespace);
    await migrateSchema(adapter, betaSchema, betaSchema.name);
  }
  return adapter;
}

export async function createDurableStreamsReadFixture(options?: {
  targetNamespace?: string | null;
  streamPath?: "schema" | "namespace";
  adapter?: DurableStreamsFixtureAdapter;
  betaOutboxEnabled?: boolean;
  secondaryTargetNamespace?: string;
  pgliteDataDir?: string;
  skipMigrations?: boolean;
}): Promise<DurableStreamsReadFixture> {
  const targetNamespace: string | null =
    options?.targetNamespace === undefined ? alphaSchema.name : options.targetNamespace;
  const adapter = await createAdapter({
    type: options?.adapter ?? "in-memory",
    targetNamespace,
    pgliteDataDir: options?.pgliteDataDir,
    skipMigrations: options?.skipMigrations,
  });

  const alphaFragment = instantiate(alphaFragmentDefinition)
    .withOptions({
      databaseAdapter: adapter,
      databaseNamespace: targetNamespace,
      mountRoute: "",
      outbox: { enabled: true },
    })
    .build();

  if (options?.secondaryTargetNamespace) {
    instantiate(alphaFragmentDefinition)
      .withOptions({
        databaseAdapter: adapter,
        databaseNamespace: options.secondaryTargetNamespace,
        mountRoute: "/secondary-alpha",
        outbox: { enabled: true },
      })
      .build();
  }

  const betaFragment = instantiate(betaFragmentDefinition)
    .withOptions({
      databaseAdapter: adapter,
      databaseNamespace: betaSchema.name,
      mountRoute: "/beta",
      outbox: options?.betaOutboxEnabled === false ? undefined : { enabled: true },
    })
    .build();

  const internalFragment = getInternalFragment(adapter);
  let pendingAbortCount = 0;
  const abortWaiters: Array<() => void> = [];
  const notifyRequestAbort = () => {
    const waiter = abortWaiters.shift();
    if (waiter) {
      waiter();
    } else {
      pendingAbortCount += 1;
    }
  };
  const waitForRequestAbort = async (): Promise<void> => {
    if (pendingAbortCount > 0) {
      pendingAbortCount -= 1;
      return;
    }
    await new Promise<void>((resolve) => abortWaiters.push(resolve));
  };

  const server = createServer(
    toNodeHandler(async (request) => {
      request.signal.addEventListener("abort", notifyRequestAbort, { once: true });
      return alphaFragment.handler(request);
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine the Durable Streams test server address.");
  }

  const origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
  const streamUrlFor = (schemaOrNamespace: string) =>
    `${origin}/_internal/outbox/durable/schema/${encodeURIComponent(schemaOrNamespace)}`;
  const streamName =
    options?.streamPath === "namespace" && targetNamespace ? targetNamespace : alphaSchema.name;

  const listOutboxEntries = async (afterVersionstamp?: string): Promise<OutboxEntry[]> =>
    await internalFragment.inContext(async function (this: DatabaseRequestContext) {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.outboxService.list({ afterVersionstamp })] as const,
        )
        .transform(({ serviceResult: [entries] }) => entries as OutboxEntry[])
        .execute();
    });

  let mutationIndex = 0;
  let latestVersionstamp: string | undefined;

  const appendedEntry = async (): Promise<OutboxEntry> => {
    const [entry] = await listOutboxEntries(latestVersionstamp);
    if (!entry) {
      throw new Error("Expected the database mutation to append an outbox entry.");
    }
    latestVersionstamp = entry.versionstamp;
    return entry;
  };

  const appendTargetMutation = async (namePrefix = "target"): Promise<OutboxEntry> => {
    const name = `${namePrefix}-${mutationIndex++}`;
    await alphaFragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx()
        .mutate(({ forSchema }) =>
          forSchema(alphaSchema).create("items", { name, recordedAt: new Date() }),
        )
        .execute();
    });
    return appendedEntry();
  };

  const appendUnrelatedMutation = async (namePrefix = "unrelated"): Promise<OutboxEntry> => {
    const name = `${namePrefix}-${mutationIndex++}`;
    await betaFragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx()
        .mutate(({ forSchema }) => forSchema(betaSchema).create("items", { name }))
        .execute();
    });
    return appendedEntry();
  };

  const appendMixedMutation = async (): Promise<OutboxEntry> => {
    await alphaFragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx({
        onBeforeMutate: (uow) => uow.registerSchema(betaSchema, betaSchema.name),
      })
        .mutate(({ forSchema }) => {
          forSchema(alphaSchema).create("items", {
            name: `mixed-alpha-${mutationIndex++}`,
            recordedAt: new Date(),
          });
          forSchema(betaSchema).create("items", { name: `mixed-beta-${mutationIndex++}` });
        })
        .execute();
    });
    return appendedEntry();
  };

  const appendTargetMutationsConcurrently = async (count: number): Promise<OutboxEntry[]> => {
    const afterVersionstamp = latestVersionstamp;
    await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        await alphaFragment.inContext(async function (this: DatabaseRequestContext) {
          await this.handlerTx()
            .mutate(({ forSchema }) =>
              forSchema(alphaSchema).create("items", {
                name: `concurrent-${mutationIndex++}-${index}`,
                recordedAt: new Date(),
              }),
            )
            .execute();
        });
      }),
    );

    const entries = await listOutboxEntries(afterVersionstamp);
    latestVersionstamp = entries[entries.length - 1]?.versionstamp ?? latestVersionstamp;
    return entries;
  };

  const appendReferenceMutation = async (): Promise<OutboxEntry> => {
    const email = `user-${mutationIndex++}@example.com`;
    const userId = await alphaFragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx()
        .mutate(({ forSchema }) => forSchema(alphaSchema).create("users", { email }))
        .execute();

      const user = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(alphaSchema).findFirst("users", (builder) =>
            builder.whereIndex("idx_users_email", (expression) => expression("email", "=", email)),
          ),
        )
        .transformRetrieve(([result]) => result)
        .execute();
      if (!user?.id.internalId) {
        throw new Error("Expected a user with an internal ID.");
      }
      return user.id;
    });
    await appendedEntry();

    await alphaFragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx()
        .mutate(({ forSchema }) =>
          forSchema(alphaSchema).create("posts", {
            title: "Referenced post",
            authorId: FragnoReference.fromInternal(userId.internalId as bigint),
          }),
        )
        .execute();
    });
    return appendedEntry();
  };

  return {
    streamUrl: streamUrlFor(streamName),
    streamUrlFor,
    appendTargetMutation,
    appendUnrelatedMutation,
    appendMixedMutation,
    appendReferenceMutation,
    appendTargetMutationsConcurrently,
    listOutboxEntries,
    waitForRequestAbort,
    close: async () => {
      await closeServer(server);
      await adapter.close();
    },
  };
}
