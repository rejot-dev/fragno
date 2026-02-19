import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "../with-database";
import { schema, idColumn, column } from "../schema/create";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { SchemaRegistryCollisionError, internalSchema } from "./internal-fragment";
import { getInternalFragment, getRegistryForAdapterSync } from "../internal/adapter-registry";
import type { SyncCommandDefinition } from "../sync/types";
import type { TxResult } from "../query/unit-of-work/execute-unit-of-work";

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

const setupAdapter = async ({ migrateInternal = true } = {}) => {
  const sqliteDatabase = new SQLite(":memory:");

  const dialect = new SqliteDialect({
    database: sqliteDatabase,
  });

  const adapter = new SqlAdapter({
    dialect,
    driverConfig: new BetterSQLite3DriverConfig(),
  });

  if (migrateInternal) {
    const migrations = adapter.prepareMigrations(internalSchema, null);
    await migrations.executeWithDriver(adapter.driver, 0);
  }

  const close = async () => {
    await adapter.close();
    sqliteDatabase.close();
  };

  return { adapter, close };
};

describe("internal fragment describe routes", () => {
  it("aggregates adapter schemas and fragments", async () => {
    const { adapter, close } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const betaDef = defineFragment("beta-fragment").extend(withDatabase(betaSchema)).build();

    const alphaFragment = instantiate(alphaDef)
      .withOptions({ databaseAdapter: adapter, mountRoute: "/alpha" })
      .build();

    const betaFragment = instantiate(betaDef)
      .withOptions({ databaseAdapter: adapter, mountRoute: "/beta" })
      .build();

    const response = await alphaFragment.callRouteRaw("GET", "/_internal" as never);
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.adapterIdentity).toEqual(expect.any(String));
    expect(payload.routes.internal).toBe("/_internal");
    expect(payload.routes.outbox).toBeUndefined();

    expect(payload.fragments).toEqual([]);

    expect(payload.schemas).toEqual(
      expect.arrayContaining([
        {
          name: alphaSchema.name,
          namespace: alphaSchema.name,
          version: alphaSchema.version,
          tables: Object.keys(alphaSchema.tables).sort(),
        },
        {
          name: betaSchema.name,
          namespace: betaSchema.name,
          version: betaSchema.version,
          tables: Object.keys(betaSchema.tables).sort(),
        },
      ]),
    );

    expect(
      payload.schemas.some(
        (schemaInfo: { name: string }) => schemaInfo.name === internalSchema.name,
      ),
    ).toBe(false);

    const betaResponse = await betaFragment.callRouteRaw("GET", "/_internal" as never);
    const betaPayload = await betaResponse.json();

    expect(betaPayload.adapterIdentity).toBe(payload.adapterIdentity);
    expect(betaPayload.fragments).toEqual([]);

    await close();
  });

  it("returns an error when internal settings are unavailable", async () => {
    const { adapter, close } = await setupAdapter({ migrateInternal: false });

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const alphaFragment = instantiate(alphaDef)
      .withOptions({ databaseAdapter: adapter, mountRoute: "/alpha" })
      .build();

    const response = await alphaFragment.callRouteRaw("GET", "/_internal" as never);
    expect(response.status).toBe(500);

    const payload = await response.json();
    expect(payload.error).toEqual(
      expect.objectContaining({
        code: "SETTINGS_UNAVAILABLE",
      }),
    );

    await close();
  });

  it("exposes the outbox route only when enabled", async () => {
    const { adapter: outboxAdapter, close: closeOutbox } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const betaDef = defineFragment("beta-fragment").extend(withDatabase(betaSchema)).build();

    const alphaFragment = instantiate(alphaDef)
      .withOptions({
        databaseAdapter: outboxAdapter,
        mountRoute: "/alpha",
        outbox: { enabled: true },
      })
      .build();

    const betaFragment = instantiate(betaDef)
      .withOptions({ databaseAdapter: outboxAdapter, mountRoute: "/beta" })
      .build();

    const response = await alphaFragment.callRouteRaw("GET", "/_internal" as never);
    const payload = await response.json();
    expect(payload.routes.outbox).toBe("/_internal/outbox");
    expect(payload.fragments).toEqual(
      expect.arrayContaining([{ name: "alpha-fragment", mountRoute: "/alpha" }]),
    );
    expect(payload.fragments).not.toEqual(
      expect.arrayContaining([{ name: "beta-fragment", mountRoute: "/beta" }]),
    );

    const outboxResponse = await alphaFragment.callRouteRaw("GET", "/_internal/outbox" as never);
    expect(outboxResponse.status).toBe(200);
    await expect(outboxResponse.json()).resolves.toEqual([]);

    const betaResponse = await betaFragment.callRouteRaw("GET", "/_internal" as never);
    const betaPayload = await betaResponse.json();
    expect(betaPayload.routes.outbox).toBe("/_internal/outbox");
    expect(betaPayload.fragments).toEqual(
      expect.arrayContaining([{ name: "alpha-fragment", mountRoute: "/alpha" }]),
    );

    await closeOutbox();

    const { adapter: noOutboxAdapter, close: closeNoOutbox } = await setupAdapter();
    const gammaDef = defineFragment("gamma-fragment").extend(withDatabase(betaSchema)).build();
    const gammaFragment = instantiate(gammaDef)
      .withOptions({ databaseAdapter: noOutboxAdapter, mountRoute: "/gamma" })
      .build();

    const noOutboxResponse = await gammaFragment.callRouteRaw("GET", "/_internal/outbox" as never);
    expect(noOutboxResponse.status).toBe(404);

    await closeNoOutbox();
  });

  it("throws when two fragments claim the same namespace", async () => {
    const { adapter, close } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const betaDef = defineFragment("beta-fragment").extend(withDatabase(betaSchema)).build();

    instantiate(alphaDef)
      .withOptions({ databaseAdapter: adapter, databaseNamespace: "shared" })
      .build();

    expect(() => {
      instantiate(betaDef)
        .withOptions({ databaseAdapter: adapter, databaseNamespace: "shared" })
        .build();
    }).toThrow(SchemaRegistryCollisionError);

    await close();
  });
});

describe("internal fragment outbox routes", () => {
  it("filters outbox entries by shard", async () => {
    const { adapter, close } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const alphaFragment = instantiate(alphaDef)
      .withOptions({
        databaseAdapter: adapter,
        mountRoute: "/alpha",
        outbox: { enabled: true },
        shardingStrategy: { mode: "row" },
      })
      .build();

    alphaFragment.withMiddleware(async ({ headers }, { deps }) => {
      deps.shardContext.set(headers.get("x-fragno-shard"));
      return undefined;
    });

    const namespace = (alphaFragment.$internal.deps as { namespace: string | null }).namespace;
    const migrations = adapter.prepareMigrations(alphaSchema, namespace);
    await migrations.executeWithDriver(adapter.driver, 0);

    await alphaFragment.inContext(async function () {
      this.setShard("tenant-a");
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(alphaSchema).create("alpha_items", { name: "Tenant A" });
        })
        .execute();
    });

    await alphaFragment.inContext(async function () {
      this.setShard("tenant-b");
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(alphaSchema).create("alpha_items", { name: "Tenant B" });
        })
        .execute();
    });

    const response = await alphaFragment.handler(
      new Request("http://localhost/alpha/_internal/outbox", {
        method: "GET",
        headers: { "x-fragno-shard": "tenant-a" },
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toHaveLength(1);
    expect(payload[0]?.payload?.json).toEqual(
      expect.objectContaining({
        mutations: [
          expect.objectContaining({
            values: expect.objectContaining({ name: "Tenant A" }),
          }),
        ],
      }),
    );

    await close();
  });
});

describe("internal fragment sync routes", () => {
  const registerAlphaSyncCommands = (adapter: SqlAdapter) => {
    const registry = getRegistryForAdapterSync(adapter);
    const commands = new Map<string, SyncCommandDefinition>([
      [
        "createItem",
        {
          name: "createItem",
          handler: async ({ input, tx }) => {
            const payload = input as { name: string; id?: string };
            await tx()
              .mutate(({ forSchema }) => {
                const record = payload.id
                  ? { id: payload.id, name: payload.name }
                  : { name: payload.name };
                forSchema(alphaSchema).create("alpha_items", record);
              })
              .execute();
          },
        },
      ],
      [
        "updateItemUnchecked",
        {
          name: "updateItemUnchecked",
          handler: async ({ input, tx }) => {
            const payload = input as { id: string; name: string };
            await tx()
              .mutate(({ forSchema }) => {
                forSchema(alphaSchema).update("alpha_items", payload.id, (b) =>
                  b.set({ name: payload.name }),
                );
              })
              .execute();
          },
        },
      ],
    ]);

    registry.registerSyncCommands({
      fragmentName: "alpha-fragment",
      schemaName: alphaSchema.name,
      namespace: alphaSchema.name,
      commands,
    });
  };

  it("applies commands and records sync requests", async () => {
    const { adapter, close } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const alphaFragment = instantiate(alphaDef)
      .withOptions({
        databaseAdapter: adapter,
        mountRoute: "/alpha",
        outbox: { enabled: true },
      })
      .build();

    const namespace = (alphaFragment.$internal.deps as { namespace: string | null }).namespace;
    const migrations = adapter.prepareMigrations(alphaSchema, namespace);
    await migrations.executeWithDriver(adapter.driver, 0);

    registerAlphaSyncCommands(adapter);

    const describeResponse = await alphaFragment.callRouteRaw("GET", "/_internal" as never);
    const describePayload = await describeResponse.json();

    const submitResponse = await alphaFragment.callRouteRaw(
      "POST",
      "/_internal/sync" as never,
      {
        body: {
          requestId: "req-1",
          adapterIdentity: describePayload.adapterIdentity,
          conflictResolutionStrategy: "server",
          commands: [
            {
              id: "cmd-1",
              name: "createItem",
              target: { fragment: "alpha-fragment", schema: alphaSchema.name },
              input: { name: "First" },
            },
          ],
        },
      } as unknown as Parameters<typeof alphaFragment.callRouteRaw>[2],
    );

    expect(submitResponse.status).toBe(200);
    const submitPayload = await submitResponse.json();
    expect(submitPayload.status).toBe("applied");
    expect(submitPayload.confirmedCommandIds).toEqual(["cmd-1"]);
    expect(submitPayload.entries.length).toBeGreaterThan(0);
    expect(submitPayload.lastVersionstamp).toEqual(expect.any(String));

    const internalFragment = getInternalFragment(adapter);
    const syncRecord = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(internalSchema).findFirst("fragno_db_sync_requests", (b) =>
            b.whereIndex("idx_sync_request_id", (eb) => eb("requestId", "=", "req-1")),
          ),
        )
        .transformRetrieve(([result]) => result)
        .execute();
    });
    expect(syncRecord?.requestId).toBe("req-1");

    const secondResponse = await alphaFragment.callRouteRaw(
      "POST",
      "/_internal/sync" as never,
      {
        body: {
          requestId: "req-1",
          adapterIdentity: describePayload.adapterIdentity,
          conflictResolutionStrategy: "server",
          commands: [
            {
              id: "cmd-1",
              name: "createItem",
              target: { fragment: "alpha-fragment", schema: alphaSchema.name },
              input: { name: "First" },
            },
          ],
        },
      } as unknown as Parameters<typeof alphaFragment.callRouteRaw>[2],
    );
    const secondPayload = await secondResponse.json();
    expect(secondPayload.status).toBe("conflict");
    expect(secondPayload.reason).toBe("already_handled");
    expect(secondPayload.confirmedCommandIds).toEqual(["cmd-1"]);

    await close();
  });

  it("returns limit_exceeded when too many commands are submitted", async () => {
    const { adapter, close } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const alphaFragment = instantiate(alphaDef)
      .withOptions({
        databaseAdapter: adapter,
        mountRoute: "/alpha",
        outbox: { enabled: true },
      })
      .build();

    registerAlphaSyncCommands(adapter);

    const describeResponse = await alphaFragment.callRouteRaw("GET", "/_internal" as never);
    const describePayload = await describeResponse.json();

    const commands = Array.from({ length: 101 }, (_, index) => ({
      id: `cmd-${index + 1}`,
      name: "createItem",
      target: { fragment: "alpha-fragment", schema: alphaSchema.name },
      input: { name: `Item ${index + 1}` },
    }));

    const submitResponse = await alphaFragment.callRouteRaw(
      "POST",
      "/_internal/sync" as never,
      {
        body: {
          requestId: "req-2",
          adapterIdentity: describePayload.adapterIdentity,
          conflictResolutionStrategy: "server",
          commands,
        },
      } as unknown as Parameters<typeof alphaFragment.callRouteRaw>[2],
    );

    const submitPayload = await submitResponse.json();
    expect(submitPayload.status).toBe("conflict");
    expect(submitPayload.reason).toBe("limit_exceeded");

    await close();
  });

  it("scopes sync responses by shard", async () => {
    const { adapter, close } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const alphaFragment = instantiate(alphaDef)
      .withOptions({
        databaseAdapter: adapter,
        mountRoute: "/alpha",
        outbox: { enabled: true },
        shardingStrategy: { mode: "row" },
      })
      .build();

    alphaFragment.withMiddleware(async ({ headers }, { deps }) => {
      deps.shardContext.set(headers.get("x-fragno-shard"));
      return undefined;
    });

    const namespace = (alphaFragment.$internal.deps as { namespace: string | null }).namespace;
    const migrations = adapter.prepareMigrations(alphaSchema, namespace);
    await migrations.executeWithDriver(adapter.driver, 0);

    await alphaFragment.inContext(async function () {
      this.setShard("tenant-a");
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(alphaSchema).create("alpha_items", { name: "Tenant A" });
        })
        .execute();
    });

    await alphaFragment.inContext(async function () {
      this.setShard("tenant-b");
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(alphaSchema).create("alpha_items", { name: "Tenant B" });
        })
        .execute();
    });

    const describeResponse = await alphaFragment.handler(
      new Request("http://localhost/alpha/_internal", {
        method: "GET",
        headers: { "x-fragno-shard": "tenant-a" },
      }),
    );
    const describePayload = await describeResponse.json();

    const submitResponse = await alphaFragment.handler(
      new Request("http://localhost/alpha/_internal/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fragno-shard": "tenant-a",
        },
        body: JSON.stringify({
          requestId: "req-shard-tenant-a",
          adapterIdentity: describePayload.adapterIdentity,
          conflictResolutionStrategy: "server",
          commands: [],
        }),
      }),
    );

    expect(submitResponse.status).toBe(200);
    const submitPayload = await submitResponse.json();
    expect(submitPayload.status).toBe("conflict");
    expect(submitPayload.reason).toBe("no_commands");
    expect(submitPayload.entries).toHaveLength(1);
    expect(submitPayload.entries[0]?.payload?.json).toEqual(
      expect.objectContaining({
        mutations: [
          expect.objectContaining({
            values: expect.objectContaining({ name: "Tenant A" }),
          }),
        ],
      }),
    );

    await close();
  });

  it.todo("returns conflict when a write key changes after the base versionstamp", async () => {
    const { adapter, close } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const alphaFragment = instantiate(alphaDef)
      .withOptions({
        databaseAdapter: adapter,
        mountRoute: "/alpha",
        outbox: { enabled: true },
      })
      .build();

    const namespace = (alphaFragment.$internal.deps as { namespace: string | null }).namespace;
    const migrations = adapter.prepareMigrations(alphaSchema, namespace);
    await migrations.executeWithDriver(adapter.driver, 0);

    registerAlphaSyncCommands(adapter);

    const describeResponse = await alphaFragment.callRouteRaw("GET", "/_internal" as never);
    const describePayload = await describeResponse.json();

    const createResponse = await alphaFragment.callRouteRaw(
      "POST",
      "/_internal/sync" as never,
      {
        body: {
          requestId: "req-conflict-create",
          adapterIdentity: describePayload.adapterIdentity,
          conflictResolutionStrategy: "server",
          commands: [
            {
              id: "cmd-create",
              name: "createItem",
              target: { fragment: "alpha-fragment", schema: alphaSchema.name },
              input: { id: "item-1", name: "First" },
            },
          ],
        },
      } as unknown as Parameters<typeof alphaFragment.callRouteRaw>[2],
    );

    const createPayload = await createResponse.json();
    expect(createPayload.status).toBe("applied");
    const baseVersionstamp = createPayload.lastVersionstamp;
    expect(baseVersionstamp).toEqual(expect.any(String));

    await alphaFragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(alphaSchema).update("alpha_items", "item-1", (b) => b.set({ name: "Server" }));
        })
        .execute();
    });

    const submitResponse = await alphaFragment.callRouteRaw(
      "POST",
      "/_internal/sync" as never,
      {
        body: {
          requestId: "req-conflict-update",
          adapterIdentity: describePayload.adapterIdentity,
          conflictResolutionStrategy: "server",
          baseVersionstamp,
          commands: [
            {
              id: "cmd-update",
              name: "updateItemUnchecked",
              target: { fragment: "alpha-fragment", schema: alphaSchema.name },
              input: { id: "item-1", name: "Client" },
            },
          ],
        },
      } as unknown as Parameters<typeof alphaFragment.callRouteRaw>[2],
    );

    const submitPayload = await submitResponse.json();
    expect(submitPayload.status).toBe("conflict");
    if (submitPayload.status === "conflict") {
      expect(submitPayload.reason).toBe("conflict");
    }

    await close();
  });

  it("supports handlerTx with service calls inside sync commands", async () => {
    const { adapter, close } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment")
      .extend(withDatabase(alphaSchema))
      .providesService("alphaService", ({ defineService }) =>
        defineService({
          countItems() {
            return this.serviceTx(alphaSchema)
              .retrieve((uow) =>
                uow.find("alpha_items", (b) => b.whereIndex("primary").selectCount()),
              )
              .transformRetrieve(([count]) => (typeof count === "number" ? count : 0))
              .build();
          },
        }),
      )
      .build();

    const alphaFragment = instantiate(alphaDef)
      .withOptions({
        databaseAdapter: adapter,
        mountRoute: "/alpha",
        outbox: { enabled: true },
      })
      .build();

    const namespace = (alphaFragment.$internal.deps as { namespace: string | null }).namespace;
    const migrations = adapter.prepareMigrations(alphaSchema, namespace);
    await migrations.executeWithDriver(adapter.driver, 0);

    const registry = getRegistryForAdapterSync(adapter);
    const alphaService = alphaFragment.services.alphaService as {
      countItems: () => TxResult<number>;
    };
    const commands = new Map<string, SyncCommandDefinition>([
      [
        "createItemWithCount",
        {
          name: "createItemWithCount",
          createServerContext: () => ({ alphaService }),
          handler: async ({ input, tx, ctx }) => {
            const payload = input as { name: string };
            const serviceCtx = ctx as { alphaService: { countItems: () => TxResult<number> } };
            await tx()
              .withServiceCalls(() => [serviceCtx.alphaService.countItems()] as const)
              .mutate(({ forSchema, serviceIntermediateResult: [count] }) => {
                forSchema(alphaSchema).create("alpha_items", {
                  name: `${payload.name}-${count}`,
                });
              })
              .execute();
          },
        },
      ],
    ]);

    registry.registerSyncCommands({
      fragmentName: "alpha-fragment",
      schemaName: alphaSchema.name,
      namespace: alphaSchema.name,
      commands,
    });

    const describeResponse = await alphaFragment.callRouteRaw("GET", "/_internal" as never);
    const describePayload = await describeResponse.json();

    const submitResponse = await alphaFragment.callRouteRaw(
      "POST",
      "/_internal/sync" as never,
      {
        body: {
          requestId: "req-service",
          adapterIdentity: describePayload.adapterIdentity,
          conflictResolutionStrategy: "server",
          commands: [
            {
              id: "cmd-service",
              name: "createItemWithCount",
              target: { fragment: "alpha-fragment", schema: alphaSchema.name },
              input: { name: "First" },
            },
          ],
        },
      } as unknown as Parameters<typeof alphaFragment.callRouteRaw>[2],
    );

    expect(submitResponse.status).toBe(200);

    const createdItem = await alphaFragment.inContext(async function () {
      return await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(alphaSchema).findFirst("alpha_items", (b) => b.whereIndex("primary")),
        )
        .transformRetrieve(([result]) => result)
        .execute();
    });

    expect(createdItem?.name).toBe("First-0");

    await close();
  });
});
