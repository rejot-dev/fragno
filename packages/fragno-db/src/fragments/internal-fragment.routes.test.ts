import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "../with-database";
import { schema, idColumn, column } from "../schema/create";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { internalSchema } from "./internal-fragment";

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
  let sqliteDatabase: SQLite.Database;
  let adapter: SqlAdapter;

  beforeAll(async () => {
    sqliteDatabase = new SQLite(":memory:");

    const dialect = new SqliteDialect({
      database: sqliteDatabase,
    });

    adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    const migrations = adapter.prepareMigrations(internalSchema, null);
    await migrations.executeWithDriver(adapter.driver, 0);
  }, 12000);

  it("aggregates adapter schemas and fragments", async () => {
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

    expect(payload.adapterIdentity.source).toBe("settings");
    expect(typeof payload.adapterIdentity.id).toBe("string");

    expect(payload.fragments).toEqual(
      expect.arrayContaining([
        { name: "alpha-fragment", mountRoute: "/alpha" },
        { name: "beta-fragment", mountRoute: "/beta" },
      ]),
    );

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

    expect(betaPayload.fragments).toEqual(
      expect.arrayContaining([
        { name: "alpha-fragment", mountRoute: "/alpha" },
        { name: "beta-fragment", mountRoute: "/beta" },
      ]),
    );
  });
});
