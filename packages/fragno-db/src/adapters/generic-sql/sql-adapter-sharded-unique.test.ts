import { PGlite } from "@electric-sql/pglite";
import SQLite from "better-sqlite3";
import { KyselyPGlite } from "kysely-pglite";
import { SqliteDialect } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqlAdapter, type UnitOfWorkConfig } from "./generic-sql-adapter";
import { BetterSQLite3DriverConfig, PGLiteDriverConfig } from "./driver-config";
import { column, idColumn, schema } from "../../schema/create";
import { internalSchema } from "../../fragments/internal-fragment";
import type { ShardScope } from "../../sharding";

const globalUniqueSchema = schema("unique_global", (s) =>
  s.addTable("users", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("email", column("string"))
      .addColumn("name", column("string"))
      .createIndex("idx_users_email_unique", ["email"], { unique: true }),
  ),
);

const shardUniqueSchema = schema("unique_shard", (s) =>
  s.addTable("users", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("email", column("string"))
      .addColumn("name", column("string"))
      .createIndex("idx_users_email_shard_unique", ["email", "_shard"], { unique: true }),
  ),
);

type AdapterHarness = {
  name: string;
  createAdapter: (
    uowConfig: UnitOfWorkConfig,
  ) => Promise<{ adapter: SqlAdapter; close: () => void | Promise<void> }>;
};

const adapters: AdapterHarness[] = [
  {
    name: "PGLite",
    async createAdapter(uowConfig) {
      const pgliteDatabase = new PGlite();
      const { dialect } = new KyselyPGlite(pgliteDatabase);
      const adapter = new SqlAdapter({
        dialect,
        driverConfig: new PGLiteDriverConfig(),
        uowConfig,
      });

      return {
        adapter,
        close: async () => {
          await adapter.close();
        },
      };
    },
  },
  {
    name: "SQLite",
    async createAdapter(uowConfig) {
      const sqliteDatabase = new SQLite(":memory:");
      const dialect = new SqliteDialect({ database: sqliteDatabase });
      const adapter = new SqlAdapter({
        dialect,
        driverConfig: new BetterSQLite3DriverConfig(),
        uowConfig,
      });

      return {
        adapter,
        close: async () => {
          await adapter.close();
          sqliteDatabase.close();
        },
      };
    },
  },
];

let emailCounter = 0;
const uniqueEmail = (label: string) => `shard-unique-${label}-${emailCounter++}@example.com`;

adapters.forEach(({ name, createAdapter }) => {
  describe(`SqlAdapter ${name} - sharded unique constraints`, () => {
    let adapter: SqlAdapter;
    let globalQuery: ReturnType<SqlAdapter["createQueryEngine"]>;
    let shardQuery: ReturnType<SqlAdapter["createQueryEngine"]>;
    let currentShard: string | null = null;
    let currentShardScope: ShardScope = "scoped";
    let closeAdapter: (() => void | Promise<void>) | undefined;

    const setShardContext = (shard: string | null, scope: ShardScope = "scoped") => {
      currentShard = shard;
      currentShardScope = scope;
    };

    const makeUowConfig = (): UnitOfWorkConfig => ({
      shardingStrategy: { mode: "row" },
      getShard: () => currentShard,
      getShardScope: () => currentShardScope,
    });

    async function createUser(
      queryEngine: typeof globalQuery,
      options: { shard: string | null; email: string; name: string; scope?: ShardScope },
    ) {
      setShardContext(options.shard, options.scope ?? "scoped");
      const uow = queryEngine.createUnitOfWork(`create-${options.name}`);
      uow.create("users", { email: options.email, name: options.name });
      const { success } = await uow.executeMutations();
      expect(success).toBe(true);
      const createdIds = uow.getCreatedIds();
      return createdIds[0]!;
    }

    beforeAll(async () => {
      const harness = await createAdapter(makeUowConfig());
      adapter = harness.adapter;
      closeAdapter = harness.close;

      const systemMigrations = adapter.prepareMigrations(internalSchema, "");
      await systemMigrations.executeWithDriver(adapter.driver, 0);

      const globalMigrations = adapter.prepareMigrations(globalUniqueSchema, "global");
      await globalMigrations.executeWithDriver(adapter.driver, 0);

      const shardMigrations = adapter.prepareMigrations(shardUniqueSchema, "sharded");
      await shardMigrations.executeWithDriver(adapter.driver, 0);

      globalQuery = adapter.createQueryEngine(globalUniqueSchema, "global");
      shardQuery = adapter.createQueryEngine(shardUniqueSchema, "sharded");
    }, 12000);

    beforeEach(() => {
      setShardContext(null, "scoped");
    });

    afterAll(async () => {
      if (closeAdapter) {
        await closeAdapter();
      }
    });

    it("rejects duplicates across shards when unique index does not include _shard", async () => {
      const email = uniqueEmail("global-cross-shard");
      await createUser(globalQuery, { shard: "alpha", email, name: "alpha" });

      await expect(createUser(globalQuery, { shard: "beta", email, name: "beta" })).rejects.toThrow(
        /unique|duplicate/i,
      );
    });

    it("rejects duplicates within the same shard when unique index does not include _shard", async () => {
      const email = uniqueEmail("global-same-shard");
      await createUser(globalQuery, { shard: "alpha", email, name: "alpha" });

      await expect(
        createUser(globalQuery, { shard: "alpha", email, name: "alpha-dup" }),
      ).rejects.toThrow(/unique|duplicate/i);
    });

    it("rejects duplicates when shard is null in global scope with global unique index", async () => {
      const email = uniqueEmail("global-null-shard");
      await createUser(globalQuery, { shard: null, scope: "global", email, name: "global" });

      await expect(
        createUser(globalQuery, { shard: null, scope: "global", email, name: "global-dup" }),
      ).rejects.toThrow(/unique|duplicate/i);
    });

    it("rejects updates that violate global unique indexes across shards", async () => {
      const emailAlpha = uniqueEmail("global-update-alpha");
      const emailBeta = uniqueEmail("global-update-beta");

      await createUser(globalQuery, { shard: "alpha", email: emailAlpha, name: "alpha" });
      const betaId = await createUser(globalQuery, {
        shard: "beta",
        email: emailBeta,
        name: "beta",
      });

      setShardContext("beta");
      const uow = globalQuery.createUnitOfWork("update-beta-email");
      uow.update("users", betaId, (b) => b.set({ email: emailAlpha }));

      await expect(uow.executeMutations()).rejects.toThrow(/unique|duplicate/i);
    });

    it("allows duplicates across shards when unique index includes _shard", async () => {
      const email = uniqueEmail("shard-cross-shard");
      await createUser(shardQuery, { shard: "alpha", email, name: "alpha" });
      await createUser(shardQuery, { shard: "beta", email, name: "beta" });
    });

    it("rejects duplicates within the same shard when unique index includes _shard", async () => {
      const email = uniqueEmail("shard-same-shard");
      await createUser(shardQuery, { shard: "alpha", email, name: "alpha" });

      await expect(
        createUser(shardQuery, { shard: "alpha", email, name: "alpha-dup" }),
      ).rejects.toThrow(/unique|duplicate/i);
    });

    it.skip("rejects duplicates when shard is null in global scope with unique _shard index (skipped: NULLs are distinct in SQL unique indexes)", async () => {
      const email = uniqueEmail("shard-null-shard");
      await createUser(shardQuery, { shard: null, scope: "global", email, name: "global" });

      await expect(
        createUser(shardQuery, { shard: null, scope: "global", email, name: "global-dup" }),
      ).rejects.toThrow(/unique|duplicate/i);
    });

    it("allows updates to values used in other shards when unique index includes _shard", async () => {
      const emailAlpha = uniqueEmail("shard-update-alpha");
      const emailBeta = uniqueEmail("shard-update-beta");

      await createUser(shardQuery, { shard: "alpha", email: emailAlpha, name: "alpha" });
      const betaId = await createUser(shardQuery, {
        shard: "beta",
        email: emailBeta,
        name: "beta",
      });

      setShardContext("beta");
      const uow = shardQuery.createUnitOfWork("update-beta-email");
      uow.update("users", betaId, (b) => b.set({ email: emailAlpha }));

      const { success } = await uow.executeMutations();
      expect(success).toBe(true);
    });

    it("rejects updates within the same shard when unique index includes _shard", async () => {
      const emailAlpha = uniqueEmail("shard-update-same-alpha");
      const emailBeta = uniqueEmail("shard-update-same-beta");

      await createUser(shardQuery, { shard: "alpha", email: emailAlpha, name: "alpha-a" });
      const alphaId = await createUser(shardQuery, {
        shard: "alpha",
        email: emailBeta,
        name: "alpha-b",
      });

      setShardContext("alpha");
      const uow = shardQuery.createUnitOfWork("update-alpha-email");
      uow.update("users", alphaId, (b) => b.set({ email: emailAlpha }));

      await expect(uow.executeMutations()).rejects.toThrow(/unique|duplicate/i);
    });
  });
});
