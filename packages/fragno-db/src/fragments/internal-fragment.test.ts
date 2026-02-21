import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { instantiate } from "@fragno-dev/core";
import {
  internalFragmentDef,
  internalSchema,
  SETTINGS_NAMESPACE,
  getSchemaVersionFromDatabase,
} from "./internal-fragment";
import type { FragnoPublicConfigWithDatabase } from "../db-fragment-definition-builder";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { ExponentialBackoffRetryPolicy, NoRetryPolicy } from "../query/unit-of-work/retry-policy";
import { dbNow } from "../query/db-now";
import type { FragnoId } from "../schema/create";
import { getRegistryForAdapterSync } from "../internal/adapter-registry";

type OptionsWithAdapter = FragnoPublicConfigWithDatabase & {
  databaseAdapter: SqlAdapter;
};

describe("Internal Fragment", () => {
  let sqliteDatabase: SQLite.Database;
  let adapter: SqlAdapter;
  let fragment: ReturnType<typeof instantiateFragment>;

  function instantiateFragment(options: OptionsWithAdapter) {
    return instantiate(internalFragmentDef)
      .withConfig({ registry: getRegistryForAdapterSync(options.databaseAdapter) })
      .withOptions(options)
      .build();
  }

  beforeAll(async () => {
    sqliteDatabase = new SQLite(":memory:");

    const dialect = new SqliteDialect({
      database: sqliteDatabase,
    });

    adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    {
      const migrations = adapter.prepareMigrations(internalSchema, null);
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    // Instantiate fragment with shared database adapter
    const options: OptionsWithAdapter = {
      databaseAdapter: adapter,
      databaseNamespace: null,
    };

    fragment = instantiateFragment(options);

    return async () => {
      await adapter.close();
    };
  }, 12000);

  it("should get undefined for non-existent key", async () => {
    const result = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.settingsService.get(SETTINGS_NAMESPACE, "test-key")] as const,
        )
        .transform(({ serviceResult: [value] }) => value)
        .execute();
    });

    expect(result).toBeUndefined();
  });

  it("should set and get a value", async () => {
    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.settingsService.set(SETTINGS_NAMESPACE, "test-key", "test-value"),
        ])
        .execute();
    });

    const result = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.settingsService.get(SETTINGS_NAMESPACE, "test-key")] as const,
        )
        .transform(({ serviceResult: [value] }) => value)
        .execute();
    });

    expect(result).toMatchObject({
      key: "fragno-db-settings.test-key",
      value: "test-value",
    });
  });

  it("should update an existing value", async () => {
    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(
          () =>
            [
              fragment.services.settingsService.set(
                SETTINGS_NAMESPACE,
                "test-key",
                "updated-value",
              ),
            ] as const,
        )
        .execute();
    });

    const result = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.settingsService.get(SETTINGS_NAMESPACE, "test-key")] as const,
        )
        .transform(({ serviceResult: [value] }) => value)
        .execute();
    });

    expect(result).toMatchObject({
      key: "fragno-db-settings.test-key",
      value: "updated-value",
    });
  });

  it("should delete a value", async () => {
    // First get the ID
    const setting = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.settingsService.get(SETTINGS_NAMESPACE, "test-key")] as const,
        )
        .transform(({ serviceResult: [value] }) => value)
        .execute();
    });

    expect(setting).toBeDefined();

    // Delete it
    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [fragment.services.settingsService.delete(setting!.id)] as const)
        .execute();
    });

    // Verify it's gone
    const result = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.settingsService.get(SETTINGS_NAMESPACE, "test-key")] as const,
        )
        .transform(({ serviceResult: [value] }) => value)
        .execute();
    });

    expect(result).toBeUndefined();
  });
});

describe("Hook Service", () => {
  let sqliteDatabase: SQLite.Database;
  let adapter: SqlAdapter;
  let fragment: ReturnType<typeof instantiateFragment>;

  function instantiateFragment(options: OptionsWithAdapter) {
    return instantiate(internalFragmentDef)
      .withConfig({ registry: getRegistryForAdapterSync(options.databaseAdapter) })
      .withOptions(options)
      .build();
  }

  beforeAll(async () => {
    sqliteDatabase = new SQLite(":memory:");

    const dialect = new SqliteDialect({
      database: sqliteDatabase,
    });

    adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    {
      const migrations = adapter.prepareMigrations(internalSchema, null);
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    const options: OptionsWithAdapter = {
      databaseAdapter: adapter,
      databaseNamespace: null,
    };

    fragment = instantiateFragment(options);

    return async () => {
      await adapter.close();
    };
  }, 12000);

  it("should create a hook event and retrieve it by namespace", async () => {
    const nonce = "test-nonce-1";

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
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
        })
        .execute();
    });

    const events = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.hookService.getHooksByNamespace("test-namespace")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    const event = events.find((entry) => entry.hookName === "onTest" && entry.status === "pending");
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      hookName: "onTest",
      payload: { test: "data" },
      attempts: 0,
      maxAttempts: 5,
      status: "pending",
      nonce,
    });
  });

  it("should mark a hook event as processing", async () => {
    const nonce = "test-nonce-3";
    let eventId: FragnoId;

    await fragment.inContext(async function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
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
        })
        .execute();
    });

    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.hookService.markHookProcessing(eventId)] as const,
        )
        .execute();
    });

    const result = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [fragment.services.hookService.getHookById(eventId)] as const)
        .transform(({ serviceResult: [event] }) => event)
        .execute();
    });

    expect(result).toBeDefined();
    expect(result?.status).toBe("processing");
    expect(result?.lastAttemptAt).toBeInstanceOf(Date);
  });

  it("should mark a hook event as failed with retry scheduled", async () => {
    const nonce = "test-nonce-4";
    let eventId: FragnoId;

    await fragment.inContext(async function () {
      const createdId = await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          return uow.create("fragno_hooks", {
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
        })
        .execute();
      eventId = createdId;
    });

    const retryPolicy = new ExponentialBackoffRetryPolicy({ maxRetries: 3 });

    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(
          () =>
            [
              fragment.services.hookService.markHookFailed(eventId, "Test error", 0, retryPolicy),
            ] as const,
        )
        .execute();
    });

    const result = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [fragment.services.hookService.getHookById(eventId)] as const)
        .transform(({ serviceResult: [event] }) => event)
        .execute();
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
      const createdId = await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          return uow.create("fragno_hooks", {
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
        })
        .execute();
      eventId = createdId;
    });

    const retryPolicy = new NoRetryPolicy();

    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(
          () =>
            [
              fragment.services.hookService.markHookFailed(
                eventId,
                "Max attempts reached",
                0,
                retryPolicy,
              ),
            ] as const,
        )
        .execute();
    });

    const result = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [fragment.services.hookService.getHookById(eventId)] as const)
        .transform(({ serviceResult: [event] }) => event)
        .execute();
    });

    expect(result).toBeDefined();
    expect(result?.status).toBe("failed");
    expect(result?.attempts).toBe(1);
    expect(result?.error).toBe("Max attempts reached");
  });

  it("should claim only ready pending events and mark them processing", async () => {
    const namespace = "claim-ready";
    const pastTime = new Date(Date.now() - 10000);
    const futureTime = new Date(Date.now() + 60000);

    let nullRetryId!: FragnoId;
    let pastRetryId!: FragnoId;
    let futureRetryId!: FragnoId;
    let otherNamespaceId!: FragnoId;

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          nullRetryId = uow.create("fragno_hooks", {
            namespace,
            hookName: "onNullRetry",
            payload: { test: "null" },
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            lastAttemptAt: null,
            nextRetryAt: null,
            error: null,
            nonce: "test-nonce-claim-null",
          });
          pastRetryId = uow.create("fragno_hooks", {
            namespace,
            hookName: "onPastRetry",
            payload: { test: "past" },
            status: "pending",
            attempts: 1,
            maxAttempts: 5,
            lastAttemptAt: pastTime,
            nextRetryAt: pastTime,
            error: "Previous error",
            nonce: "test-nonce-claim-past",
          });
          futureRetryId = uow.create("fragno_hooks", {
            namespace,
            hookName: "onFutureRetry",
            payload: { test: "future" },
            status: "pending",
            attempts: 1,
            maxAttempts: 5,
            lastAttemptAt: new Date(),
            nextRetryAt: futureTime,
            error: "Previous error",
            nonce: "test-nonce-claim-future",
          });
          otherNamespaceId = uow.create("fragno_hooks", {
            namespace: "other-namespace",
            hookName: "onOtherNamespace",
            payload: { test: "other" },
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            lastAttemptAt: null,
            nextRetryAt: null,
            error: null,
            nonce: "test-nonce-claim-other",
          });
        })
        .execute();
    });

    const claimed = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.hookService.claimPendingHookEvents(namespace)] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    expect(claimed).toHaveLength(2);
    const claimedIds = new Set(claimed.map((event) => event.id.externalId));
    expect(claimedIds.has(nullRetryId.externalId)).toBe(true);
    expect(claimedIds.has(pastRetryId.externalId)).toBe(true);
    expect(claimedIds.has(futureRetryId.externalId)).toBe(false);
    expect(claimedIds.has(otherNamespaceId.externalId)).toBe(false);

    const [nullEvent, pastEvent, futureEvent, otherEvent] = await fragment.inContext(
      async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () =>
              [
                fragment.services.hookService.getHookById(nullRetryId),
                fragment.services.hookService.getHookById(pastRetryId),
                fragment.services.hookService.getHookById(futureRetryId),
                fragment.services.hookService.getHookById(otherNamespaceId),
              ] as const,
          )
          .transform(({ serviceResult: [nullResult, pastResult, futureResult, otherResult] }) => [
            nullResult,
            pastResult,
            futureResult,
            otherResult,
          ])
          .execute();
      },
    );

    expect(nullEvent?.status).toBe("processing");
    expect(nullEvent?.lastAttemptAt).toBeInstanceOf(Date);
    expect(pastEvent?.status).toBe("processing");
    expect(pastEvent?.lastAttemptAt).toBeInstanceOf(Date);
    expect(futureEvent?.status).toBe("pending");
    expect(otherEvent?.status).toBe("pending");
  });

  it("should return claimed ids with incremented versions", async () => {
    const namespace = "claim-version";
    const nonce = "test-nonce-claim-version";
    let createdId!: FragnoId;

    await fragment.inContext(async function () {
      createdId = await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          return uow.create("fragno_hooks", {
            namespace,
            hookName: "onClaimVersion",
            payload: { test: "version" },
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            lastAttemptAt: null,
            nextRetryAt: null,
            error: null,
            nonce,
          });
        })
        .execute();
    });

    const claimed = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.hookService.claimPendingHookEvents(namespace)] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id.externalId).toBe(createdId.externalId);
    expect(claimed[0]?.id.version).toBe(createdId.version + 1);
  });

  it("should claim stale processing events and return stuck metadata", async () => {
    const namespace = "claim-stuck";
    const staleBefore = dbNow().plus({ minutes: -1 });
    const staleLastAttemptAt = new Date(Date.now() - 5 * 60_000);
    const freshLastAttemptAt = new Date(Date.now() - 10_000);
    const staleNextRetryAt = new Date(Date.now() + 60_000);

    let staleId!: FragnoId;
    let freshId!: FragnoId;

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          staleId = uow.create("fragno_hooks", {
            namespace,
            hookName: "onStuck",
            payload: { test: "stuck" },
            status: "processing",
            attempts: 1,
            maxAttempts: 5,
            lastAttemptAt: staleLastAttemptAt,
            nextRetryAt: staleNextRetryAt,
            error: null,
            nonce: "test-nonce-stuck",
          });
          freshId = uow.create("fragno_hooks", {
            namespace,
            hookName: "onFresh",
            payload: { test: "fresh" },
            status: "processing",
            attempts: 0,
            maxAttempts: 5,
            lastAttemptAt: freshLastAttemptAt,
            nextRetryAt: null,
            error: null,
            nonce: "test-nonce-fresh",
          });
        })
        .execute();
    });

    const claimResult = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () =>
            [
              fragment.services.hookService.claimStuckProcessingHookEvents(namespace, staleBefore),
            ] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    expect(claimResult.events).toHaveLength(1);
    expect(claimResult.events[0]?.hookName).toBe("onStuck");
    expect(claimResult.events[0]?.id.version).toBe(staleId.version + 1);

    expect(claimResult.stuckEvents).toHaveLength(1);
    expect(claimResult.stuckEvents[0]?.hookName).toBe("onStuck");
    expect(claimResult.stuckEvents[0]?.id.externalId).toBe(staleId.externalId);
    expect(claimResult.stuckEvents[0]?.id.version).toBe(staleId.version);
    expect(claimResult.stuckEvents[0]?.lastAttemptAt?.getTime()).toBe(staleLastAttemptAt.getTime());
    expect(claimResult.stuckEvents[0]?.nextRetryAt?.getTime()).toBe(staleNextRetryAt.getTime());

    const [staleEvent, freshEvent] = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () =>
            [
              fragment.services.hookService.getHookById(staleId),
              fragment.services.hookService.getHookById(freshId),
            ] as const,
        )
        .transform(({ serviceResult: [staleResult, freshResult] }) => [staleResult, freshResult])
        .execute();
    });

    expect(staleEvent?.status).toBe("processing");
    expect(staleEvent?.nextRetryAt).toBeNull();
    expect(staleEvent?.lastAttemptAt).toBeInstanceOf(Date);
    expect(staleEvent?.lastAttemptAt?.getTime()).toBeGreaterThan(staleLastAttemptAt.getTime());
    expect(freshEvent?.lastAttemptAt).toBeInstanceOf(Date);
    expect(
      Math.abs((freshEvent?.lastAttemptAt?.getTime() ?? 0) - freshLastAttemptAt.getTime()),
    ).toBeLessThan(2000);
  });

  it("should return now when pending hooks have no nextRetryAt", async () => {
    const namespace = "wake-now";

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          uow.create("fragno_hooks", {
            namespace,
            hookName: "onImmediate",
            payload: { test: "now" },
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            lastAttemptAt: null,
            nextRetryAt: null,
            error: null,
            nonce: "test-nonce-now",
          });
        })
        .execute();
    });

    const wakeAt = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.hookService.getNextHookWakeAt(namespace)] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    expect(wakeAt).toBeInstanceOf(Date);
    expect(Math.abs((wakeAt as Date).getTime() - Date.now())).toBeLessThan(5000);
  });

  it("should return earliest scheduled hook time", async () => {
    const namespace = "wake-future";
    const soon = new Date(Date.now() + 10000);
    const later = new Date(Date.now() + 60000);

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalSchema);
          uow.create("fragno_hooks", {
            namespace,
            hookName: "onSoon",
            payload: { test: "soon" },
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            lastAttemptAt: null,
            nextRetryAt: soon,
            error: null,
            nonce: "test-nonce-soon",
          });
          uow.create("fragno_hooks", {
            namespace,
            hookName: "onLater",
            payload: { test: "later" },
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            lastAttemptAt: null,
            nextRetryAt: later,
            error: null,
            nonce: "test-nonce-later",
          });
        })
        .execute();
    });

    const wakeAt = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.hookService.getNextHookWakeAt(namespace)] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    expect(wakeAt).toEqual(soon);
  });

  it("should return null when no pending hooks exist", async () => {
    const namespace = "wake-none";
    const wakeAt = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.hookService.getNextHookWakeAt(namespace)] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    expect(wakeAt).toBeNull();
  });
});

describe("getSchemaVersionFromDatabase", () => {
  function createTestSetup() {
    const sqliteDatabase = new SQLite(":memory:");
    const dialect = new SqliteDialect({ database: sqliteDatabase });
    const adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    function instantiateFragment(options: FragnoPublicConfigWithDatabase) {
      return instantiate(internalFragmentDef).withConfig({}).withOptions(options).build();
    }

    return { sqliteDatabase, adapter, instantiateFragment };
  }

  async function setupAndMigrate() {
    const { sqliteDatabase, adapter, instantiateFragment } = createTestSetup();
    // Create tables without writing a version record, so tests control version state
    const migrations = adapter.prepareMigrations(internalSchema, "");
    await migrations.executeWithDriver(adapter.driver, 0, undefined, {
      updateVersionInMigration: false,
    });
    const fragment = instantiateFragment({
      databaseAdapter: adapter,
      databaseNamespace: null,
    });
    return { sqliteDatabase, adapter, fragment };
  }

  it("should return 0 when no version exists", async () => {
    const { fragment } = await setupAndMigrate();

    const version = await getSchemaVersionFromDatabase(fragment, "nonexistent");
    expect(version).toBe(0);
  });

  it("should find version stored under empty-string namespace", async () => {
    const { fragment } = await setupAndMigrate();

    // Write version under empty-string namespace (key = ".schema_version")
    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [fragment.services.settingsService.set("", "schema_version", "5")])
        .execute();
    });

    const version = await getSchemaVersionFromDatabase(fragment, "");
    expect(version).toBe(5);
  });

  it("should find version via back-compat when stored under internalSchema.name but read with empty string", async () => {
    const { fragment } = await setupAndMigrate();

    // Write version under "fragno_internal" namespace (legacy key from buggy code)
    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.settingsService.set(internalSchema.name, "schema_version", "3"),
        ])
        .execute();
    });

    // Reading with "" should find it via back-compat fallback
    const version = await getSchemaVersionFromDatabase(fragment, "");
    expect(version).toBe(3);
  });

  it("should find version via back-compat when stored under empty string but read with internalSchema.name", async () => {
    const { fragment } = await setupAndMigrate();

    // Write version under empty-string namespace
    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [fragment.services.settingsService.set("", "schema_version", "7")])
        .execute();
    });

    // Reading with internalSchema.name should find it via back-compat fallback
    const version = await getSchemaVersionFromDatabase(fragment, internalSchema.name);
    expect(version).toBe(7);
  });

  it("should prefer primary namespace over back-compat fallback", async () => {
    const { fragment } = await setupAndMigrate();

    // Write version under BOTH namespaces with different values
    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.settingsService.set("", "schema_version", "10"),
          fragment.services.settingsService.set(internalSchema.name, "schema_version", "20"),
        ])
        .execute();
    });

    // Reading with "" should find 10 (primary), not 20 (back-compat)
    const versionEmpty = await getSchemaVersionFromDatabase(fragment, "");
    expect(versionEmpty).toBe(10);

    // Reading with internalSchema.name should find 20 (primary), not 10 (back-compat)
    const versionNamed = await getSchemaVersionFromDatabase(fragment, internalSchema.name);
    expect(versionNamed).toBe(20);
  });

  it("should not use back-compat for non-internal namespaces", async () => {
    const { fragment } = await setupAndMigrate();

    // Write version under "some-fragment"
    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.settingsService.set("some-fragment", "schema_version", "4"),
        ])
        .execute();
    });

    // Reading with a different non-internal namespace should NOT find it
    const version = await getSchemaVersionFromDatabase(fragment, "other-fragment");
    expect(version).toBe(0);
  });
});
