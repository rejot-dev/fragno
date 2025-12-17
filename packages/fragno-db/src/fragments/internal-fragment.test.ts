import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { instantiate } from "@fragno-dev/core";
import { internalFragmentDef, internalSchema, SETTINGS_NAMESPACE } from "./internal-fragment";
import type { FragnoPublicConfigWithDatabase } from "../db-fragment-definition-builder";
import { DrizzleAdapter } from "../adapters/drizzle/drizzle-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { ExponentialBackoffRetryPolicy, NoRetryPolicy } from "../query/unit-of-work/retry-policy";
import type { FragnoId } from "../schema/create";

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
      const migrations = adapter.prepareMigrations(internalSchema, "");
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

describe("Hook Service", () => {
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
      const migrations = adapter.prepareMigrations(internalSchema, "");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    const options: FragnoPublicConfigWithDatabase = {
      databaseAdapter: adapter,
    };

    fragment = instantiateFragment(options);

    return async () => {
      await adapter.close();
    };
  }, 12000);

  it("should create a hook event and retrieve it by namespace", async () => {
    const nonce = "test-nonce-1";

    await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeMutate }) => {
        const uow = forSchema(internalSchema);
        uow.create("fragno_hooks", {
          namespace: "test-namespace",
          hookName: "onTest",
          payload: { test: "data" },
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          lastAttemptAt: null,
          nextRetryAt: null,
          error: null,
          nonce,
        });
        uow.create("fragno_hooks", {
          namespace: "test-namespace",
          hookName: "onTest",
          payload: { test: "already-completed-data" },
          status: "completed",
          attempts: 0,
          maxAttempts: 5,
          lastAttemptAt: null,
          nextRetryAt: null,
          error: null,
          nonce,
        });
        await executeMutate();
      });
    });

    const events = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const eventsPromise = fragment.services.hookService.getPendingHookEvents("test-namespace");
        await executeRetrieve();
        return await eventsPromise;
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      hookName: "onTest",
      payload: { test: "data" },
      attempts: 0,
      maxAttempts: 5,
      nonce,
    });
  });

  it("should mark a hook event as completed", async () => {
    const nonce = "test-nonce-2";
    let eventId: FragnoId;

    await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeMutate }) => {
        const uow = forSchema(internalSchema);
        eventId = uow.create("fragno_hooks", {
          namespace: "test-namespace",
          hookName: "onComplete",
          payload: { test: "data" },
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          lastAttemptAt: null,
          nextRetryAt: null,
          error: null,
          nonce,
        });
        await executeMutate();
      });
    });

    await fragment.inContext(async function () {
      return await this.uow(async ({ executeMutate }) => {
        fragment.services.hookService.markHookCompleted(eventId);
        await executeMutate();
      });
    });

    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeRetrieve }) => {
        const uow = forSchema(internalSchema);
        const findUow = uow.find("fragno_hooks", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", eventId)),
        );
        await executeRetrieve();
        const [events] = await findUow.retrievalPhase;
        return events?.[0];
      });
    });

    expect(result).toBeDefined();
    expect(result?.status).toBe("completed");
    expect(result?.lastAttemptAt).toBeInstanceOf(Date);
  });

  it("should mark a hook event as processing", async () => {
    const nonce = "test-nonce-3";
    let eventId: FragnoId;

    await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeMutate }) => {
        const uow = forSchema(internalSchema);
        eventId = uow.create("fragno_hooks", {
          namespace: "test-namespace",
          hookName: "onProcess",
          payload: { test: "data" },
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          lastAttemptAt: null,
          nextRetryAt: null,
          error: null,
          nonce,
        });
        await executeMutate();
      });
    });

    await fragment.inContext(async function () {
      return await this.uow(async ({ executeMutate }) => {
        fragment.services.hookService.markHookProcessing(eventId);
        await executeMutate();
      });
    });

    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeRetrieve }) => {
        const uow = forSchema(internalSchema);
        const findUow = uow.find("fragno_hooks", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", eventId)),
        );
        await executeRetrieve();
        const [events] = await findUow.retrievalPhase;
        return events?.[0];
      });
    });

    expect(result).toBeDefined();
    expect(result?.status).toBe("processing");
    expect(result?.lastAttemptAt).toBeInstanceOf(Date);
  });

  it("should mark a hook event as failed with retry scheduled", async () => {
    const nonce = "test-nonce-4";
    let eventId: FragnoId;

    await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeMutate }) => {
        const uow = forSchema(internalSchema);
        eventId = uow.create("fragno_hooks", {
          namespace: "test-namespace",
          hookName: "onFail",
          payload: { test: "data" },
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          lastAttemptAt: null,
          nextRetryAt: null,
          error: null,
          nonce,
        });
        await executeMutate();
      });
    });

    const retryPolicy = new ExponentialBackoffRetryPolicy({ maxRetries: 3 });

    await fragment.inContext(async function () {
      return await this.uow(async ({ executeMutate }) => {
        fragment.services.hookService.markHookFailed(eventId, "Test error", 0, retryPolicy);
        await executeMutate();
      });
    });

    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeRetrieve }) => {
        const uow = forSchema(internalSchema);
        const findUow = uow.find("fragno_hooks", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", eventId)),
        );
        await executeRetrieve();
        const [events] = await findUow.retrievalPhase;
        return events?.[0];
      });
    });

    expect(result).toBeDefined();
    expect(result?.status).toBe("pending");
    expect(result?.attempts).toBe(1);
    expect(result?.error).toBe("Test error");
    expect(result?.nextRetryAt).toBeInstanceOf(Date);
    expect(result?.lastAttemptAt).toBeInstanceOf(Date);
  });

  it("should mark a hook event as permanently failed when max attempts reached", async () => {
    const nonce = "test-nonce-5";
    let eventId: FragnoId;

    await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeMutate }) => {
        const uow = forSchema(internalSchema);
        eventId = uow.create("fragno_hooks", {
          namespace: "test-namespace",
          hookName: "onMaxFail",
          payload: { test: "data" },
          status: "pending",
          attempts: 0,
          maxAttempts: 1,
          lastAttemptAt: null,
          nextRetryAt: null,
          error: null,
          nonce,
        });
        await executeMutate();
      });
    });

    const retryPolicy = new NoRetryPolicy();

    await fragment.inContext(async function () {
      return await this.uow(async ({ executeMutate }) => {
        fragment.services.hookService.markHookFailed(
          eventId,
          "Max attempts reached",
          0,
          retryPolicy,
        );
        await executeMutate();
      });
    });

    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeRetrieve }) => {
        const uow = forSchema(internalSchema);
        const findUow = uow.find("fragno_hooks", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", eventId)),
        );
        await executeRetrieve();
        const [events] = await findUow.retrievalPhase;
        return events?.[0];
      });
    });

    expect(result).toBeDefined();
    expect(result?.status).toBe("failed");
    expect(result?.attempts).toBe(1);
    expect(result?.error).toBe("Max attempts reached");
  });

  it("should retrieve stale events ready for retry", async () => {
    const nonce = "test-nonce-6";
    let eventId: FragnoId;

    const pastTime = new Date(Date.now() - 10000);

    await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeMutate }) => {
        const uow = forSchema(internalSchema);
        eventId = uow.create("fragno_hooks", {
          namespace: "test-namespace",
          hookName: "onStale",
          payload: { test: "stale" },
          status: "pending",
          attempts: 1,
          maxAttempts: 5,
          lastAttemptAt: pastTime,
          nextRetryAt: pastTime,
          error: "Previous error",
          nonce,
        });
        await executeMutate();
      });
    });

    const events = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const eventsPromise = fragment.services.hookService.getPendingHookEvents("test-namespace");
        await executeRetrieve();
        return await eventsPromise;
      });
    });

    const staleEvent = events.find((e) => e.id.externalId === eventId.externalId);
    expect(staleEvent).toBeDefined();
    expect(staleEvent?.hookName).toBe("onStale");
    expect(staleEvent?.attempts).toBe(1);
  });

  it("should not retrieve events from different namespace", async () => {
    const nonce = "test-nonce-7";

    await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeMutate }) => {
        const uow = forSchema(internalSchema);
        uow.create("fragno_hooks", {
          namespace: "other-namespace",
          hookName: "onOther",
          payload: { test: "other" },
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          lastAttemptAt: null,
          nextRetryAt: null,
          error: null,
          nonce,
        });
        await executeMutate();
      });
    });

    const events = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const eventsPromise = fragment.services.hookService.getPendingHookEvents("test-namespace");
        await executeRetrieve();
        return await eventsPromise;
      });
    });

    const otherEvent = events.find((e) => e.hookName === "onOther");
    expect(otherEvent).toBeUndefined();
  });

  it("should not retrieve events not yet ready for retry", async () => {
    const nonce = "test-nonce-8";
    let eventId: FragnoId;

    const futureTime = new Date(Date.now() + 60000);

    await fragment.inContext(async function () {
      return await this.uow(async ({ forSchema, executeMutate }) => {
        const uow = forSchema(internalSchema);
        eventId = uow.create("fragno_hooks", {
          namespace: "test-namespace",
          hookName: "onFuture",
          payload: { test: "future" },
          status: "pending",
          attempts: 1,
          maxAttempts: 5,
          lastAttemptAt: new Date(),
          nextRetryAt: futureTime,
          error: "Previous error",
          nonce,
        });
        await executeMutate();
      });
    });

    const events = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const eventsPromise = fragment.services.hookService.getPendingHookEvents("test-namespace");
        await executeRetrieve();
        return await eventsPromise;
      });
    });

    const futureEvent = events.find((e) => e.id.externalId === eventId.externalId);
    expect(futureEvent).toBeUndefined();
  });
});
