import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "../with-database";
import { schema, idColumn, column } from "../schema/create";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
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

describe("internal fragment describe routes", () => {
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

    expect(betaPayload.fragments).toEqual([]);

    await close();
  });

  it("serves describe without internal migrations", async () => {
    const { adapter, close } = await setupAdapter({ migrateInternal: false });

    const alphaDef = defineFragment("alpha-fragment").extend(withDatabase(alphaSchema)).build();
    const alphaFragment = instantiate(alphaDef)
      .withOptions({ databaseAdapter: adapter, mountRoute: "/alpha" })
      .build();

    const response = await alphaFragment.callRouteRaw("GET", "/_internal" as never);
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.error).toBeUndefined();
    expect(payload.routes.internal).toBe("/_internal");
    expect(payload.schemas).toEqual(
      expect.arrayContaining([
        {
          name: alphaSchema.name,
          namespace: alphaSchema.name,
          version: alphaSchema.version,
          tables: Object.keys(alphaSchema.tables).sort(),
        },
      ]),
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
