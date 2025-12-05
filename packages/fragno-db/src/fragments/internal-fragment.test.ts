import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { instantiate } from "@fragno-dev/core";
import { internalFragmentDef, settingsSchema, SETTINGS_NAMESPACE } from "./internal-fragment";
import type { FragnoPublicConfigWithDatabase } from "../db-fragment-definition-builder";
import { DrizzleAdapter } from "../adapters/drizzle/drizzle-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";

describe("Internal Fragment", () => {
  let sqliteDatabase: SQLite.Database;
  let adapter: DrizzleAdapter;
  let fragment: ReturnType<typeof instantiateFragment>;

  function instantiateFragment(options: FragnoPublicConfigWithDatabase) {
    return instantiate(internalFragmentDef).withConfig({}).withOptions(options).build();
  }

  beforeAll(async () => {
    sqliteDatabase = new SQLite(":memory:");

    const dialect = new SqliteDialect({
      database: sqliteDatabase,
    });

    adapter = new DrizzleAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    {
      const migrations = adapter.prepareMigrations(settingsSchema, "");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    // Instantiate fragment with shared database adapter
    const options: FragnoPublicConfigWithDatabase = {
      databaseAdapter: adapter,
    };

    fragment = instantiateFragment(options);

    return async () => {
      await adapter.close();
    };
  }, 12000);

  it("should get undefined for non-existent key", async () => {
    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const valuePromise = fragment.services.settingsService.get(SETTINGS_NAMESPACE, "test-key");
        await executeRetrieve();
        return await valuePromise;
      });
    });

    expect(result).toBeUndefined();
  });

  it("should set and get a value", async () => {
    await fragment.inContext(async function () {
      return await this.uow(async ({ executeMutate }) => {
        const setPromise = fragment.services.settingsService.set(
          SETTINGS_NAMESPACE,
          "test-key",
          "test-value",
        );
        await executeMutate();
        await setPromise;
      });
    });

    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const valuePromise = fragment.services.settingsService.get(SETTINGS_NAMESPACE, "test-key");
        await executeRetrieve();
        return await valuePromise;
      });
    });

    expect(result).toMatchObject({
      key: "fragno-db-settings.test-key",
      value: "test-value",
    });
  });

  it("should update an existing value", async () => {
    await fragment.inContext(async function () {
      return await this.uow(async ({ executeMutate }) => {
        const setPromise = fragment.services.settingsService.set(
          SETTINGS_NAMESPACE,
          "test-key",
          "updated-value",
        );
        await executeMutate();
        await setPromise;
      });
    });

    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const valuePromise = fragment.services.settingsService.get(SETTINGS_NAMESPACE, "test-key");
        await executeRetrieve();
        return await valuePromise;
      });
    });

    expect(result).toMatchObject({
      key: "fragno-db-settings.test-key",
      value: "updated-value",
    });
  });

  it("should delete a value", async () => {
    // First get the ID
    const setting = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const valuePromise = fragment.services.settingsService.get(SETTINGS_NAMESPACE, "test-key");
        await executeRetrieve();
        return await valuePromise;
      });
    });

    expect(setting).toBeDefined();

    // Delete it
    await fragment.inContext(async function () {
      return await this.uow(async ({ executeMutate }) => {
        const deletePromise = fragment.services.settingsService.delete(setting!.id);
        await executeMutate();
        await deletePromise;
      });
    });

    // Verify it's gone
    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const valuePromise = fragment.services.settingsService.get(SETTINGS_NAMESPACE, "test-key");
        await executeRetrieve();
        return await valuePromise;
      });
    });

    expect(result).toBeUndefined();
  });
});
