import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "../with-database";
import { schema, column, idColumn } from "../schema/create";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { internalSchema } from "../fragments/internal-fragment";
import { getInternalFragment } from "../internal/adapter-registry";
import {
  createDurableHooksProcessor,
  createDurableHooksProcessorGroup,
  createDurableHooksProcessorGroupFromProcessors,
} from "./durable-hooks-processor";

const testSchema = schema("test", (s) =>
  s.addTable("items", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const testFragmentDefinition = defineFragment("test")
  .extend(withDatabase(testSchema))
  .provideHooks(({ defineHook }) => ({
    onTest: defineHook(async function () {}),
  }))
  .build();

const noHooksFragmentDefinition = defineFragment("no-hooks")
  .extend(withDatabase(testSchema))
  .build();

describe("createDurableHooksProcessor", () => {
  let adapter: SqlAdapter;
  let fragment: ReturnType<typeof instantiateFragment>;

  function instantiateFragment(options: { databaseAdapter: SqlAdapter }) {
    return instantiate(testFragmentDefinition).withConfig({}).withOptions(options).build();
  }

  beforeAll(async () => {
    const sqliteDatabase = new SQLite(":memory:");
    const dialect = new SqliteDialect({ database: sqliteDatabase });

    adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    const internalMigrations = adapter.prepareMigrations(internalSchema, null);
    await internalMigrations.executeWithDriver(adapter.driver, 0);

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

    const wakeAt = await processor.getNextWakeAt();
    expect(wakeAt).toBeInstanceOf(Date);

    const processed = await processor.process();
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

    const wakeAt = await processor.getNextWakeAt();
    expect(wakeAt).toBeInstanceOf(Date);
    expect(wakeAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("throws when fragment has no hooks configured", () => {
    const noHooksFragment = instantiate(noHooksFragmentDefinition)
      .withConfig({})
      .withOptions({ databaseAdapter: adapter })
      .build();

    expect(() => createDurableHooksProcessor(noHooksFragment)).toThrow(
      '[fragno-db] Durable hooks not configured for fragment "no-hooks".',
    );
  });

  it("skips fragments without hooks when creating a group", () => {
    const noHooksFragment = instantiate(noHooksFragmentDefinition)
      .withConfig({})
      .withOptions({ databaseAdapter: adapter })
      .build();

    const processor = createDurableHooksProcessorGroup([noHooksFragment, fragment]);
    expect(processor).not.toBeNull();
    expect(processor.namespace).toBe("test");
  });
});

describe("createDurableHooksProcessorGroupFromProcessors", () => {
  const makeProcessor = (overrides: Partial<ReturnType<typeof createProcessorStub>> = {}) => ({
    ...createProcessorStub(),
    ...overrides,
  });

  function createProcessorStub() {
    return {
      namespace: "test",
      process: vi.fn().mockResolvedValue(0),
      getNextWakeAt: vi.fn().mockResolvedValue(null),
      drain: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("returns null when there are no processors", () => {
    expect(() => createDurableHooksProcessorGroupFromProcessors([])).toThrow(
      "No processors provided for durable hooks processing.",
    );
  });

  it("returns the same processor when only one is provided", () => {
    const processor = makeProcessor({ namespace: "solo" });
    const group = createDurableHooksProcessorGroupFromProcessors([processor]);
    expect(group).toBe(processor);
  });

  it("aggregates processing results and reports errors", async () => {
    const error = new Error("processor failed");
    const onError = vi.fn();
    const processorA = makeProcessor({
      namespace: "a",
      process: vi.fn().mockResolvedValue(2),
      drain: vi.fn().mockResolvedValue(undefined),
    });
    const processorB = makeProcessor({
      namespace: "b",
      process: vi.fn().mockRejectedValue(error),
      drain: vi.fn().mockRejectedValue(error),
    });

    const group = createDurableHooksProcessorGroupFromProcessors([processorA, processorB], {
      onError,
    });
    expect(group).not.toBeNull();

    const processed = await group.process();
    expect(processed).toBe(2);
    expect(onError).toHaveBeenCalledWith(error);

    await group.drain();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("returns the earliest wake time and ignores failures", async () => {
    const error = new Error("wake failed");
    const onError = vi.fn();
    const early = new Date("2024-01-01T00:00:00Z");
    const late = new Date("2024-01-01T00:00:10Z");

    const processorA = makeProcessor({
      namespace: "a",
      getNextWakeAt: vi.fn().mockResolvedValue(late),
    });
    const processorB = makeProcessor({
      namespace: "b",
      getNextWakeAt: vi.fn().mockResolvedValue(early),
    });
    const processorC = makeProcessor({
      namespace: "c",
      getNextWakeAt: vi.fn().mockRejectedValue(error),
    });

    const group = createDurableHooksProcessorGroupFromProcessors(
      [processorA, processorB, processorC],
      { onError },
    );

    const wakeAt = await group.getNextWakeAt();
    expect(wakeAt).toEqual(early);
    expect(onError).toHaveBeenCalledWith(error);
  });
});
