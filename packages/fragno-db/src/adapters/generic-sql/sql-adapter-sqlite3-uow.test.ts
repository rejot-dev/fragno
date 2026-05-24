import { beforeAll, describe, expect, it } from "vitest";

import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { internalSchema } from "../../fragments/internal-fragment";
import type { InternalFragmentInstance } from "../../fragments/internal-fragment";
import { prepareHookMutations, type HooksMap } from "../../hooks/hooks";
import { ExponentialBackoffRetryPolicy } from "../../query/unit-of-work/retry-policy";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { BetterSQLite3DriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

describe("SqlAdapter SQLite", () => {
  const testSchema = schema("test", (s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer").nullable())
          .createIndex("name_idx", ["name"])
          .createIndex("name_id_idx", ["name", "id"]);
      })
      .addTable("emails", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("user_id", referenceColumn({ table: "users" }))
          .addColumn("email", column("string"))
          .addColumn("is_primary", column("bool").defaultTo(false))
          .createIndex("unique_email", ["email"], { unique: true })
          .createIndex("user_emails", ["user_id"]);
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("user_id", referenceColumn({ table: "users" }))
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .createIndex("posts_user_idx", ["user_id"]);
      })
      .addTable("optional_emails", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("user_id", referenceColumn({ table: "users" }).nullable())
          .addColumn("email", column("string"))
          .createIndex("optional_emails_user_idx", ["user_id"]);
      })
      .addTable("comments", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("post_id", referenceColumn({ table: "posts" }))
          .addColumn("user_id", referenceColumn({ table: "users" }))
          .addColumn("text", column("string"))
          .createIndex("comments_post_idx", ["post_id"])
          .createIndex("comments_user_idx", ["user_id"]);
      });
  });

  // Second schema for multi-schema testing
  const schema2 = schema("schema2", (s) => {
    return s
      .addTable("products", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("price", column("integer"))
          .createIndex("name_idx", ["name"]);
      })
      .addTable("orders", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("product_id", referenceColumn({ table: "products" }))
          .addColumn("quantity", column("integer"))
          .createIndex("product_orders_idx", ["product_id"]);
      });
  });

  let adapter: SqlAdapter;
  let sqliteDatabase: InstanceType<typeof SQLite>;

  beforeAll(async () => {
    sqliteDatabase = new SQLite(":memory:");

    const dialect = new SqliteDialect({
      database: sqliteDatabase,
    });

    adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    // Create settings table first (needed for version tracking)
    {
      const migrations = adapter.prepareMigrations(internalSchema, "");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    {
      const migrations = adapter.prepareMigrations(testSchema, "namespace");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    {
      const migrations = adapter.prepareMigrations(schema2, "namespace2");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    return async () => {
      await adapter.close();
    };
  }, 12000);
  it("should fail inserting duplicate triggered hook ids", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const hookId = "hook-duplicate-id";
    const hooks: HooksMap = {
      onTest: () => {},
    };

    const internalFragmentStub = {
      $internal: { deps: { schema: internalSchema } },
    } as unknown as InternalFragmentInstance;

    const buildHookUow = (name: string) => {
      const uow = queryEngine.createUnitOfWork(name).forSchema(testSchema, hooks);
      uow.triggerHook("onTest", { data: name }, { id: hookId });
      prepareHookMutations(
        uow,
        internalFragmentStub,
        new ExponentialBackoffRetryPolicy({ maxRetries: 5 }),
      );
      return uow;
    };

    const firstUow = buildHookUow("hook-duplicate-first");
    const { success } = await firstUow.executeMutations();
    expect(success).toBe(true);

    const secondUow = buildHookUow("hook-duplicate-second");
    await expect(secondUow.executeMutations()).rejects.toThrow();

    const verifyUow = queryEngine.createUnitOfWork("verify-duplicate-hook-id");
    const internalUow = verifyUow.forSchema(internalSchema);
    const findUow = internalUow.find("fragno_hooks", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", hookId)),
    );
    const [events] = await findUow.executeRetrieve();

    expect(events).toHaveLength(1);
  });
});
