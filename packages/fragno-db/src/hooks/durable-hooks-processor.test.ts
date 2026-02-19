import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "../with-database";
import { schema, column, idColumn } from "../schema/create";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { internalSchema } from "../fragments/internal-fragment";
import { getInternalFragment } from "../internal/adapter-registry";
import { createDurableHooksProcessor } from "./durable-hooks-processor";
import type { ShardingStrategy } from "../sharding";

const testSchema = schema("test", (s) =>
  s.addTable("items", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const testFragmentDefinition = defineFragment("test")
  .extend(withDatabase(testSchema))
  .provideHooks(({ defineHook }) => ({
    onTest: defineHook(async function () {}),
  }))
  .build();

describe("createDurableHooksProcessor", () => {
  let adapter: SqlAdapter;
  let fragment: ReturnType<typeof instantiateFragment>;

  function instantiateFragment(options: {
    databaseAdapter: SqlAdapter;
    shardingStrategy?: ShardingStrategy;
  }) {
    return instantiate(testFragmentDefinition).withConfig({}).withOptions(options).build();
  }

  beforeAll(async () => {
    const sqliteDatabase = new SQLite(":memory:");
    const dialect = new SqliteDialect({ database: sqliteDatabase });

    adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    const systemMigrations = adapter.prepareMigrations(internalSchema, null);
    await systemMigrations.executeWithDriver(adapter.driver, 0);

    const testMigrations = adapter.prepareMigrations(testSchema, "test");
    await testMigrations.executeWithDriver(adapter.driver, 0);

    fragment = instantiateFragment({ databaseAdapter: adapter });

    return async () => {
      await adapter.close();
    };
  }, 12000);

  it("should process pending hooks and return counts", async () => {
    const processor = createDurableHooksProcessor(fragment);
    expect(processor).not.toBeNull();

    const internalFragment = getInternalFragment(adapter);
    await internalFragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          uow.create("fragno_hooks", {
            namespace: "test",
            hookName: "onTest",
            payload: { ok: true },
            status: "pending",
            attempts: 0,
            maxAttempts: 1,
            lastAttemptAt: null,
            nextRetryAt: null,
            error: null,
            nonce: "test-nonce",
          });
        })
        .execute();
    });

    const wakeAt = await processor!.getNextWakeAt();
    expect(wakeAt).toBeInstanceOf(Date);

    const processed = await processor!.process();
    expect(processed).toBe(1);
  });

  it("should wake for stale processing hooks", async () => {
    const processor = createDurableHooksProcessor(fragment);
    expect(processor).not.toBeNull();

    const internalFragment = getInternalFragment(adapter);
    const baseNow = new Date();

    await internalFragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          uow.create("fragno_hooks", {
            namespace: "test",
            hookName: "onTest",
            payload: { ok: true },
            status: "processing",
            attempts: 0,
            maxAttempts: 1,
            lastAttemptAt: new Date(baseNow.getTime() - 20 * 60_000),
            nextRetryAt: null,
            error: null,
            nonce: "test-nonce-stuck",
          });
        })
        .execute();
    });

    const wakeAt = await processor!.getNextWakeAt();
    expect(wakeAt).toBeInstanceOf(Date);
    expect(wakeAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("should scope processing to a shard and allow global processing", async () => {
    const sqliteDatabase = new SQLite(":memory:");
    const dialect = new SqliteDialect({ database: sqliteDatabase });
    const shardedAdapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    const systemMigrations = shardedAdapter.prepareMigrations(internalSchema, null);
    await systemMigrations.executeWithDriver(shardedAdapter.driver, 0);

    const testMigrations = shardedAdapter.prepareMigrations(testSchema, "test");
    await testMigrations.executeWithDriver(shardedAdapter.driver, 0);

    const shardedFragment = instantiateFragment({
      databaseAdapter: shardedAdapter,
      shardingStrategy: { mode: "row" },
    });

    const internalFragment = getInternalFragment(shardedAdapter);

    await internalFragment.inContext(async function () {
      this.setShard("alpha");
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          uow.create("fragno_hooks", {
            namespace: "test",
            hookName: "onTest",
            payload: { ok: true },
            status: "pending",
            attempts: 0,
            maxAttempts: 1,
            lastAttemptAt: null,
            nextRetryAt: null,
            error: null,
            nonce: "test-nonce-alpha",
          });
        })
        .execute();
    });

    await internalFragment.inContext(async function () {
      this.setShard("beta");
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          uow.create("fragno_hooks", {
            namespace: "test",
            hookName: "onTest",
            payload: { ok: true },
            status: "pending",
            attempts: 0,
            maxAttempts: 1,
            lastAttemptAt: null,
            nextRetryAt: null,
            error: null,
            nonce: "test-nonce-beta",
          });
        })
        .execute();
    });

    const shardProcessor = createDurableHooksProcessor(shardedFragment, {
      scope: { mode: "shard", shard: "alpha" },
    });
    const processedAlpha = await shardProcessor!.process();
    expect(processedAlpha).toBe(1);

    const alphaEvents = await internalFragment.inContext(async function () {
      this.setShard("alpha");
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("test")] as const,
        )
        .transform(({ serviceResult: [events] }) => events)
        .execute();
    });
    expect(alphaEvents).toHaveLength(1);
    expect(alphaEvents[0].status).toBe("completed");

    const betaEvents = await internalFragment.inContext(async function () {
      this.setShard("beta");
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("test")] as const,
        )
        .transform(({ serviceResult: [events] }) => events)
        .execute();
    });
    expect(betaEvents).toHaveLength(1);
    expect(betaEvents[0].status).toBe("pending");

    const globalProcessor = createDurableHooksProcessor(shardedFragment, {
      scope: { mode: "global" },
    });
    const processedGlobal = await globalProcessor!.process();
    expect(processedGlobal).toBe(1);

    const betaEventsAfter = await internalFragment.inContext(async function () {
      this.setShard("beta");
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("test")] as const,
        )
        .transform(({ serviceResult: [events] }) => events)
        .execute();
    });
    expect(betaEventsAfter).toHaveLength(1);
    expect(betaEventsAfter[0].status).toBe("completed");

    await shardedAdapter.close();
  });
});
