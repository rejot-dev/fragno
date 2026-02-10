import { describe, expect, it } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { SQLocalKysely } from "sqlocal/kysely";
import { KyselyPGlite } from "kysely-pglite";
import { PGlite } from "@electric-sql/pglite";
import superjson, { type SuperJSONResult } from "superjson";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import type { UnitOfWorkConfig } from "../adapters/generic-sql/generic-sql-adapter";
import { PGLiteDriverConfig, SQLocalDriverConfig } from "../adapters/generic-sql/driver-config";
import type { SimpleQueryInterface } from "../query/simple-query-interface";
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
  db: SimpleQueryInterface<typeof outboxSchema>;
  internalDb: SimpleQueryInterface<typeof internalSchema, UnitOfWorkConfig>;
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
  const deps = fragment.$internal.deps as { db: SimpleQueryInterface<typeof outboxSchema> };
  const internalDb = adapter.createQueryEngine(internalSchema, "");

  return {
    db: deps.db,
    internalDb,
    internalFragment: getInternalFragment(adapter),
    cleanup,
  };
}

async function listOutbox(
  internalFragment: InternalFragmentInstance,
  options?: { afterVersionstamp?: string; limit?: number },
): Promise<OutboxEntry[]> {
  return internalFragment.inContext(async function () {
    return (await this.handlerTx()
      .withServiceCalls(() => [internalFragment.services.outboxService.list(options)] as const)
      .transform(({ serviceResult: [result] }) => result)
      .execute()) as OutboxEntry[];
  });
}

async function listOutboxMutations(
  internalDb: SimpleQueryInterface<typeof internalSchema, UnitOfWorkConfig>,
): Promise<
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
  return internalDb.find("fragno_db_outbox_mutations", (b) =>
    b.whereIndex("idx_outbox_mutations_entry").orderByIndex("idx_outbox_mutations_entry", "asc"),
  );
}

const adapterConfigs = [{ type: "kysely-sqlite" as const }, { type: "kysely-pglite" as const }];

describe("Fragno DB Outbox", () => {
  it("does not write outbox entries when disabled", async () => {
    const { db, internalFragment, internalDb, cleanup } = await buildOutboxTest({
      type: "kysely-sqlite",
    });

    await db.create("users", { email: "disabled@example.com" });

    const entries = await listOutbox(internalFragment);
    expect(entries).toHaveLength(0);
    const mutations = await listOutboxMutations(internalDb);
    expect(mutations).toHaveLength(0);

    await cleanup();
  });

  it("stores refMap placeholders and lists entries in order", async () => {
    const { db, internalFragment, cleanup } = await buildOutboxTest({
      type: "kysely-sqlite",
      outboxEnabled: true,
    });

    await db.create("users", { email: "alpha@example.com" });
    const user = await db.findFirst("users", (b) =>
      b.whereIndex("idx_users_email", (eb) => eb("email", "=", "alpha@example.com")),
    );
    expect(user).not.toBeNull();
    expect(user?.id.internalId).toBeDefined();

    await db.create("posts", {
      title: "Hello",
      authorId: FragnoReference.fromInternal(user!.id.internalId!),
    });

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
      "0.authorId": user!.id.externalId,
    });

    await internalFragment.inContext(async function () {
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
    const { db, internalFragment, internalDb, cleanup } = await buildOutboxTest({
      type: "kysely-sqlite",
      outboxEnabled: true,
    });

    await db.create("users", { email: "log-alpha@example.com" });
    const user = await db.findFirst("users", (b) =>
      b.whereIndex("idx_users_email", (eb) => eb("email", "=", "log-alpha@example.com")),
    );
    expect(user).not.toBeNull();

    await db.create("posts", {
      title: "Log",
      authorId: FragnoReference.fromInternal(user!.id.internalId!),
    });

    const entries = await listOutbox(internalFragment);
    const mutations = await listOutboxMutations(internalDb);

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
    const { db, internalFragment, cleanup } = await buildOutboxTest({
      type: "kysely-sqlite",
      outboxEnabled: true,
    });

    const uow1 = db.createUnitOfWork("uow-1");
    const uow2 = db.createUnitOfWork("uow-2");
    const uow1Id = uow1.idempotencyKey;
    const uow2Id = uow2.idempotencyKey;

    uow1.create("users", { email: "order-1@example.com" });
    uow2.create("users", { email: "order-2@example.com" });

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

      const alphaDeps = alphaFragment.$internal.deps as {
        db: SimpleQueryInterface<typeof alphaSchema>;
      };
      const betaDeps = betaFragment.$internal.deps as {
        db: SimpleQueryInterface<typeof betaSchema>;
      };

      await alphaDeps.db.create("alpha_items", { name: "alpha" });
      await betaDeps.db.create("beta_items", { title: "beta" });

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
      const { db, internalFragment, cleanup } = await buildOutboxTest(adapterConfig);

      await db.create("users", { email: "disabled@example.com" });
      const disabledEntries = await listOutbox(internalFragment);
      expect(disabledEntries).toHaveLength(0);
      await cleanup();

      const {
        db: enabledDb,
        internalFragment: enabledInternal,
        cleanup: enabledCleanup,
      } = await buildOutboxTest({
        ...adapterConfig,
        outboxEnabled: true,
      });
      await enabledDb.create("users", { email: "enabled@example.com" });
      const enabledEntries = await listOutbox(enabledInternal);
      expect(enabledEntries).toHaveLength(1);
      await enabledCleanup();
    }, 10_000);
  });
});
