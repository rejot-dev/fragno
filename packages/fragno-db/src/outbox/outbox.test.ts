import { describe, expect, it } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { SQLocalKysely } from "sqlocal/kysely";
import { KyselyPGlite } from "kysely-pglite";
import { PGlite } from "@electric-sql/pglite";
import superjson, { type SuperJSONResult } from "superjson";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { PGLiteDriverConfig, SQLocalDriverConfig } from "../adapters/generic-sql/driver-config";
import type { AnyFragnoInstantiatedDatabaseFragment, DatabaseRequestContext } from "../mod";
import { withDatabase } from "../with-database";
import { internalSchema, type InternalFragmentInstance } from "../fragments/internal-fragment";
import type { AnySchema } from "../schema/create";
import { schema, idColumn, column, referenceColumn, FragnoReference } from "../schema/create";
import { getInternalFragment } from "../internal/adapter-registry";
import type { OutboxEntry, OutboxPayload } from "./outbox";

const outboxSchema = schema("outbox", (s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .createIndex("idx_users_email", ["email"], { unique: true });
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn())
        .addColumn("title", column("string"));
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    });
});

const alphaSchema = schema("alpha", (s) =>
  s.addTable("alpha_items", (t) =>
    t.addColumn("id", idColumn()).addColumn("name", column("string")),
  ),
);

const betaSchema = schema("beta", (s) =>
  s.addTable("beta_items", (t) =>
    t.addColumn("id", idColumn()).addColumn("title", column("string")),
  ),
);

const outboxFragmentName = "outbox-test";
const outboxFragmentDef = defineFragment(outboxFragmentName)
  .extend(withDatabase(outboxSchema))
  .build();

type OutboxAdapterConfig =
  | { type: "kysely-sqlite"; outboxEnabled?: boolean }
  | { type: "kysely-pglite"; outboxEnabled?: boolean };

type OutboxTestContext = {
  fragment: AnyFragnoInstantiatedDatabaseFragment<typeof outboxSchema>;
  internalFragment: InternalFragmentInstance;
  cleanup: () => Promise<void>;
};

async function migrateSchema(
  adapter: SqlAdapter,
  schemaToMigrate: AnySchema,
  namespace: string,
): Promise<void> {
  const migrations = adapter.prepareMigrations(schemaToMigrate, namespace);
  await migrations.executeWithDriver(adapter.driver, 0);
}

async function createAdapter(config: OutboxAdapterConfig): Promise<{
  adapter: SqlAdapter;
  cleanup: () => Promise<void>;
}> {
  if (config.type === "kysely-sqlite") {
    const { dialect } = new SQLocalKysely(":memory:");
    const adapter = new SqlAdapter({
      dialect,
      driverConfig: new SQLocalDriverConfig(),
    });

    await migrateSchema(adapter, internalSchema, "");
    await migrateSchema(adapter, outboxSchema, outboxSchema.name);

    return {
      adapter,
      cleanup: async () => {
        await adapter.close();
      },
    };
  }

  const pgliteDatabase = new PGlite();
  const { dialect } = new KyselyPGlite(pgliteDatabase);
  const adapter = new SqlAdapter({
    dialect,
    driverConfig: new PGLiteDriverConfig(),
  });

  await migrateSchema(adapter, internalSchema, "");
  await migrateSchema(adapter, outboxSchema, outboxSchema.name);

  return {
    adapter,
    cleanup: async () => {
      await adapter.close();
    },
  };
}

async function buildOutboxTest(adapterConfig: OutboxAdapterConfig): Promise<OutboxTestContext> {
  const { adapter, cleanup } = await createAdapter(adapterConfig);
  const fragment = instantiate(outboxFragmentDef)
    .withConfig({})
    .withRoutes([])
    .withOptions({
      databaseAdapter: adapter,
      outbox: adapterConfig.outboxEnabled ? { enabled: true } : undefined,
    })
    .build();

  return {
    fragment,
    internalFragment: getInternalFragment(adapter),
    cleanup,
  };
}

async function listOutbox(
  internalFragment: InternalFragmentInstance,
  options?: { afterVersionstamp?: string; limit?: number },
): Promise<OutboxEntry[]> {
  return internalFragment.inContext(async function (this: DatabaseRequestContext) {
    return (await this.handlerTx()
      .withServiceCalls(() => [internalFragment.services.outboxService.list(options)] as const)
      .transform(({ serviceResult: [result] }) => result)
      .execute()) as OutboxEntry[];
  });
}

async function listOutboxMutations(internalFragment: InternalFragmentInstance): Promise<
  Array<{
    entryVersionstamp: string;
    mutationVersionstamp: string;
    uowId: string;
    schema: string;
    table: string;
    externalId: string;
    op: string;
  }>
> {
  return internalFragment.inContext(async function (this: DatabaseRequestContext) {
    return await this.handlerTx()
      .retrieve(({ forSchema }) =>
        forSchema(internalSchema).find("fragno_db_outbox_mutations", (b) =>
          b
            .whereIndex("idx_outbox_mutations_entry")
            .orderByIndex("idx_outbox_mutations_entry", "asc"),
        ),
      )
      .transformRetrieve(([result]) => result)
      .execute();
  });
}

async function createUser(
  fragment: AnyFragnoInstantiatedDatabaseFragment<typeof outboxSchema>,
  email: string,
) {
  return fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => forSchema(outboxSchema).create("users", { email }))
      .execute();

    const user = await this.handlerTx()
      .retrieve(({ forSchema }) =>
        forSchema(outboxSchema).findFirst("users", (b) =>
          b.whereIndex("idx_users_email", (eb) => eb("email", "=", email)),
        ),
      )
      .transformRetrieve(([result]) => result)
      .execute();

    if (!user) {
      throw new Error("Expected user to be created.");
    }

    return user.id;
  });
}

async function createPost(
  fragment: AnyFragnoInstantiatedDatabaseFragment<typeof outboxSchema>,
  title: string,
  authorId: FragnoReference,
) {
  return fragment.inContext(async function (this: DatabaseRequestContext) {
    return await this.handlerTx()
      .mutate(({ forSchema }) => forSchema(outboxSchema).create("posts", { title, authorId }))
      .transform(({ mutateResult }) => mutateResult)
      .execute();
  });
}

const adapterConfigs = [{ type: "kysely-sqlite" as const }, { type: "kysely-pglite" as const }];

describe("Fragno DB Outbox", () => {
  it("does not write outbox entries when disabled", async () => {
    const { fragment, internalFragment, cleanup } = await buildOutboxTest({
      type: "kysely-sqlite",
    });

    await createUser(fragment, "disabled@example.com");

    const entries = await listOutbox(internalFragment);
    expect(entries).toHaveLength(0);
    const mutations = await listOutboxMutations(internalFragment);
    expect(mutations).toHaveLength(0);

    await cleanup();
  });

  it("stores refMap placeholders and lists entries in order", async () => {
    const { fragment, internalFragment, cleanup } = await buildOutboxTest({
      type: "kysely-sqlite",
      outboxEnabled: true,
    });

    const userId = await createUser(fragment, "alpha@example.com");
    expect(userId.internalId).toBeDefined();

    await createPost(fragment, "Hello", FragnoReference.fromInternal(userId.internalId!));

    const entries = await listOutbox(internalFragment);
    expect(entries).toHaveLength(2);
    expect(entries[0].versionstamp < entries[1].versionstamp).toBe(true);

    const filtered = await listOutbox(internalFragment, {
      afterVersionstamp: entries[0].versionstamp,
      limit: 1,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].versionstamp).toBe(entries[1].versionstamp);

    const payload = superjson.deserialize(entries[1].payload as SuperJSONResult) as OutboxPayload;
    expect(payload.version).toBe(1);
    expect(payload.mutations).toHaveLength(1);
    const [mutation] = payload.mutations;
    if (mutation.op !== "create") {
      throw new Error("Expected create mutation in outbox payload.");
    }
    expect(mutation.values).toMatchObject({
      authorId: { __fragno_ref: "0.authorId" },
    });
    expect(entries[1].refMap).toEqual({
      "0.authorId": userId.externalId,
    });

    await internalFragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx()
        .withServiceCalls(() => [
          internalFragment.services.settingsService.set("outbox-test", "noop", "1"),
        ])
        .execute();
    });

    const afterInternal = await listOutbox(internalFragment);
    expect(afterInternal).toHaveLength(2);

    await cleanup();
  });

  it("writes mutation log rows for each outbox entry", async () => {
    const { fragment, internalFragment, cleanup } = await buildOutboxTest({
      type: "kysely-sqlite",
      outboxEnabled: true,
    });

    const userId = await createUser(fragment, "log-alpha@example.com");
    expect(userId.internalId).toBeDefined();

    await createPost(fragment, "Log", FragnoReference.fromInternal(userId.internalId!));

    const entries = await listOutbox(internalFragment);
    const mutations = await listOutboxMutations(internalFragment);

    expect(entries).toHaveLength(2);
    expect(mutations).toHaveLength(2);

    const entryByVersion = new Map(entries.map((entry) => [entry.versionstamp, entry]));

    for (const entry of entries) {
      const payload = superjson.deserialize(entry.payload as SuperJSONResult) as OutboxPayload;
      expect(payload.mutations).toHaveLength(1);
    }

    for (const mutationRow of mutations) {
      const entry = entryByVersion.get(mutationRow.entryVersionstamp);
      expect(entry).toBeDefined();
      const payload = superjson.deserialize(entry!.payload as SuperJSONResult) as OutboxPayload;
      const mutation = payload.mutations[0];
      expect(mutationRow.mutationVersionstamp).toBe(mutation.versionstamp);
      expect(mutationRow.uowId).toBe(entry!.uowId);
      expect(mutationRow.schema).toBe(mutation.schema);
      expect(mutationRow.table).toBe(mutation.table);
      expect(mutationRow.externalId).toBe(mutation.externalId);
      expect(mutationRow.op).toBe(mutation.op);
    }

    await cleanup();
  });

  it("orders outbox entries by commit order across concurrent UOWs", async () => {
    const { fragment, internalFragment, cleanup } = await buildOutboxTest({
      type: "kysely-sqlite",
      outboxEnabled: true,
    });

    const createUow = fragment.$internal.deps.createUnitOfWork;
    const uow1 = createUow();
    const uow2 = createUow();
    const uow1Id = uow1.idempotencyKey;
    const uow2Id = uow2.idempotencyKey;

    uow1.forSchema(outboxSchema).create("users", { email: "order-1@example.com" });
    uow2.forSchema(outboxSchema).create("users", { email: "order-2@example.com" });

    const completionOrder: string[] = [];
    await Promise.all([
      uow1.executeMutations().then(() => completionOrder.push(uow1Id)),
      uow2.executeMutations().then(() => completionOrder.push(uow2Id)),
    ]);

    const entries = await listOutbox(internalFragment);
    expect(entries.map((entry) => entry.uowId)).toEqual(completionOrder);
    expect(entries[0].versionstamp < entries[1].versionstamp).toBe(true);

    await cleanup();
  });

  it("only writes outbox entries for schemas that opt in", async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    const adapter = new SqlAdapter({
      dialect,
      driverConfig: new SQLocalDriverConfig(),
    });

    try {
      await migrateSchema(adapter, internalSchema, "");
      await migrateSchema(adapter, alphaSchema, alphaSchema.name);
      await migrateSchema(adapter, betaSchema, betaSchema.name);

      const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
      const betaDef = defineFragment("beta-fragment").extend(withDatabase(betaSchema)).build();

      const alphaFragment = instantiate(alphaDef)
        .withConfig({})
        .withRoutes([])
        .withOptions({ databaseAdapter: adapter, outbox: { enabled: true } })
        .build();

      const betaFragment = instantiate(betaDef)
        .withConfig({})
        .withRoutes([])
        .withOptions({ databaseAdapter: adapter })
        .build();

      await alphaFragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(alphaSchema).create("alpha_items", { name: "alpha" }),
          )
          .execute();
      });

      await betaFragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) => forSchema(betaSchema).create("beta_items", { title: "beta" }))
          .execute();
      });

      const entries = await listOutbox(getInternalFragment(adapter));
      const mutationSchemas = entries
        .map((entry) => superjson.deserialize(entry.payload as SuperJSONResult) as OutboxPayload)
        .flatMap((payload) => payload.mutations.map((mutation) => mutation.schema));

      expect(mutationSchemas).toContain(alphaSchema.name);
      expect(mutationSchemas).not.toContain(betaSchema.name);
    } finally {
      await adapter.close();
    }
  });

  describe.each(adapterConfigs)("adapter opt-in (%s)", (adapterConfig) => {
    it("writes outbox rows only when enabled", async () => {
      const { fragment, internalFragment, cleanup } = await buildOutboxTest(adapterConfig);

      await createUser(fragment, "disabled@example.com");
      const disabledEntries = await listOutbox(internalFragment);
      expect(disabledEntries).toHaveLength(0);
      await cleanup();

      const {
        fragment: enabledFragment,
        internalFragment: enabledInternal,
        cleanup: enabledCleanup,
      } = await buildOutboxTest({
        ...adapterConfig,
        outboxEnabled: true,
      });
      await createUser(enabledFragment, "enabled@example.com");
      const enabledEntries = await listOutbox(enabledInternal);
      expect(enabledEntries).toHaveLength(1);
      await enabledCleanup();
    }, 10_000);
  });
});
