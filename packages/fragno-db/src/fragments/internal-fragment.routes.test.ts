import { describe, expect, it, assert } from "vitest";

import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";

import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { getInternalFragment, getRegistryForAdapterSync } from "../internal/adapter-registry";
import type { DatabaseRequestContext } from "../mod";
import type { TxResult } from "../query/unit-of-work/execute-unit-of-work";
import { schema, idColumn, column } from "../schema/create";
import type { SyncCommandDefinition } from "../sync/types";
import { withDatabase } from "../with-database";
import { SchemaRegistryCollisionError, internalSchema } from "./internal-fragment";

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

const streamSchema = schema("stream", (s) =>
  s.addTable("stream_items", (t) =>
    t.addColumn("id", idColumn()).addColumn("name", column("string")),
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
    assert(response.status === 200);
    const payload = await response.json();

    expect(payload.adapterIdentity).toEqual(expect.any(String));
    assert(payload.routes.internal === "/_internal");
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

    assert(
      !payload.schemas.some(
        (schemaInfo: { name: string }) => schemaInfo.name === internalSchema.name,
      ),
    );

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
    assert(response.status === 500);

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
    assert(payload.routes.outbox === "/_internal/outbox");
    assert(payload.routes.outboxStream === "/_internal/outbox/stream");
    assert(payload.routes.outboxDurableStream === "/_internal/outbox/durable/schema/:schema");
    assert(payload.routes.outboxDurableStreamAll === "/_internal/outbox/durable/all");
    expect(payload.fragments).toEqual(
      expect.arrayContaining([{ name: "alpha-fragment", mountRoute: "/alpha" }]),
    );
    expect(payload.fragments).not.toEqual(
      expect.arrayContaining([{ name: "beta-fragment", mountRoute: "/beta" }]),
    );

    const outboxResponse = await alphaFragment.callRouteRaw("GET", "/_internal/outbox" as never);
    assert(outboxResponse.status === 200);
    await expect(outboxResponse.json()).resolves.toEqual([]);

    const durableOutboxResponse = await alphaFragment.callRouteRaw(
      "GET",
      "/_internal/outbox/durable/all" as never,
    );
    assert(durableOutboxResponse.status === 200);
    assert(durableOutboxResponse.headers.get("stream-up-to-date") === "true");
    await expect(durableOutboxResponse.json()).resolves.toEqual([]);

    const betaResponse = await betaFragment.callRouteRaw("GET", "/_internal" as never);
    const betaPayload = await betaResponse.json();
    assert(betaPayload.routes.outbox === "/_internal/outbox");
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
    assert(noOutboxResponse.status === 404);
    await expect(noOutboxResponse.json()).resolves.toEqual({
      error: {
        code: "OUTBOX_UNAVAILABLE",
        message: "Outbox is not enabled for this adapter.",
      },
    });

    const noOutboxStreamResponse = await gammaFragment.callRouteRaw(
      "GET",
      "/_internal/outbox/stream" as never,
    );
    assert(noOutboxStreamResponse.status === 404);
    await expect(noOutboxStreamResponse.json()).resolves.toEqual({
      error: {
        code: "OUTBOX_UNAVAILABLE",
        message: "Outbox is not enabled for this adapter.",
      },
    });

    const noDurableOutboxResponse = await gammaFragment.callRouteRaw(
      "GET",
      "/_internal/outbox/durable/all" as never,
    );
    assert(noDurableOutboxResponse.status === 404);

    await closeNoOutbox();
  });

  it("does not expose internal hook mutations through the public outbox", async () => {
    const { adapter, close } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const alphaFragment = instantiate(alphaDef)
      .withOptions({
        databaseAdapter: adapter,
        mountRoute: "/alpha",
        outbox: { enabled: true },
      })
      .build();

    const internalFragment = getInternalFragment(adapter);
    await internalFragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(internalSchema).create("fragno_hooks", {
            namespace: alphaSchema.name,
            hookName: "testHook",
            payload: { eventId: "event-1" },
            status: "pending",
            nonce: "event-1:testHook",
          });
        })
        .execute();
    });

    const hookRecord = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(internalSchema).findFirst("fragno_hooks", (b) =>
            b.whereIndex("idx_nonce", (eb) => eb("nonce", "=", "event-1:testHook")),
          ),
        )
        .transformRetrieve(([result]) => result)
        .execute();
    });
    assert(hookRecord?.hookName === "testHook");

    const outboxResponse = await alphaFragment.callRouteRaw("GET", "/_internal/outbox" as never);
    assert(outboxResponse.status === 200);
    await expect(outboxResponse.json()).resolves.toEqual([]);

    await close();
  });

  it("streams outbox entries after the requested versionstamp", async () => {
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

    const createAlphaItem = async (name: string) => {
      await alphaFragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) => forSchema(alphaSchema).create("alpha_items", { name }))
          .execute();
      });
    };

    await createAlphaItem("first");
    const outboxResponse = await alphaFragment.callRoute("GET", "/_internal/outbox" as never);
    assert(outboxResponse.type === "json");
    const existingEntries = outboxResponse.data as Array<{ versionstamp: string }>;
    expect(existingEntries).toHaveLength(1);

    await createAlphaItem("second");

    const streamResponse = await alphaFragment.callRoute(
      "GET",
      "/_internal/outbox/stream" as never,
      {
        query: {
          afterVersionstamp: existingEntries[0].versionstamp,
          limit: "1",
        },
      } as unknown as Parameters<typeof alphaFragment.callRoute>[2],
    );
    assert(streamResponse.status === 200);
    assert(streamResponse.type === "jsonStream");

    try {
      const nextFrame = await Promise.race([
        streamResponse.stream.next(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for outbox stream frame.")), 1_000);
        }),
      ]);
      assert(nextFrame.done === false);
      const streamedEntry = nextFrame.value as { versionstamp: string };
      expect(streamedEntry.versionstamp).toEqual(expect.any(String));
      expect(streamedEntry.versionstamp).not.toBe(existingEntries[0].versionstamp);
    } finally {
      await streamResponse.stream.return(undefined);
    }

    await close();
  });

  it("exposes all enabled schemas through the adapter-wide Durable Stream", async () => {
    const { adapter, close } = await setupAdapter();

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const betaDef = defineFragment("beta-fragment").extend(withDatabase(betaSchema)).build();
    const alphaFragment = instantiate(alphaDef)
      .withOptions({ databaseAdapter: adapter, mountRoute: "/alpha", outbox: { enabled: true } })
      .build();
    const betaFragment = instantiate(betaDef)
      .withOptions({ databaseAdapter: adapter, mountRoute: "/beta", outbox: { enabled: true } })
      .build();

    const alphaNamespace = (alphaFragment.$internal.deps as { namespace: string | null }).namespace;
    const betaNamespace = (betaFragment.$internal.deps as { namespace: string | null }).namespace;
    await adapter
      .prepareMigrations(alphaSchema, alphaNamespace)
      .executeWithDriver(adapter.driver, 0);
    await adapter.prepareMigrations(betaSchema, betaNamespace).executeWithDriver(adapter.driver, 0);

    await alphaFragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx()
        .mutate(({ forSchema }) => forSchema(alphaSchema).create("alpha_items", { name: "Ada" }))
        .execute();
    });
    await betaFragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx()
        .mutate(({ forSchema }) => forSchema(betaSchema).create("beta_items", { title: "Grace" }))
        .execute();
    });

    const response = await alphaFragment.callRouteRaw(
      "GET",
      "/_internal/outbox/durable/all" as never,
    );
    assert(response.status === 200);
    const entries = (await response.json()) as Array<{
      payload: { json: { mutations: Array<{ schemaName?: string }> } };
    }>;
    expect(
      entries.flatMap((entry) =>
        entry.payload.json.mutations.map((mutation) => mutation.schemaName),
      ),
    ).toEqual([alphaSchema.name, betaSchema.name]);

    await close();
  });

  it("keeps a schema named stream distinct from the legacy NDJSON route", async () => {
    const { adapter, close } = await setupAdapter();
    const streamDef = defineFragment("stream-fragment").extend(withDatabase(streamSchema)).build();
    const streamFragment = instantiate(streamDef)
      .withOptions({ databaseAdapter: adapter, mountRoute: "", outbox: { enabled: true } })
      .build();
    const namespace = (streamFragment.$internal.deps as { namespace: string | null }).namespace;
    await adapter.prepareMigrations(streamSchema, namespace).executeWithDriver(adapter.driver, 0);

    await streamFragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx()
        .mutate(({ forSchema }) =>
          forSchema(streamSchema).create("stream_items", { name: "schema-stream" }),
        )
        .execute();
    });

    const response = await streamFragment.handler(
      new Request("http://fragno.local/_internal/outbox/durable/schema/stream"),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toHaveLength(1);

    await close();
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

    assert(submitResponse.status === 200);
    const submitPayload = await submitResponse.json();
    assert(submitPayload.status === "applied");
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
    assert(syncRecord?.requestId === "req-1");

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
    assert(secondPayload.status === "conflict");
    assert(secondPayload.reason === "already_handled");
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
    assert(submitPayload.status === "conflict");
    assert(submitPayload.reason === "limit_exceeded");

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
    assert(createPayload.status === "applied");
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
    assert(submitPayload.status === "conflict");
    if (submitPayload.status === "conflict") {
      assert(submitPayload.reason === "conflict");
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

    assert(submitResponse.status === 200);

    const createdItem = await alphaFragment.inContext(async function () {
      return await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(alphaSchema).findFirst("alpha_items", (b) => b.whereIndex("primary")),
        )
        .transformRetrieve(([result]) => result)
        .execute();
    });

    assert(createdItem?.name === "First-0");

    await close();
  });
});
