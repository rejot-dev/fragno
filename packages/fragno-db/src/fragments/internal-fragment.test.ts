import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import { instantiate } from "@fragno-dev/core";
import { internalFragmentDef, settingsSchema } from "./internal-fragment";
import type { FragnoPublicConfigWithDatabase } from "../db-fragment-definition-builder";
import { DrizzleAdapter } from "../adapters/drizzle/drizzle-adapter";
import type { DBType } from "../adapters/drizzle/shared";
import { writeAndLoadSchema } from "../adapters/drizzle/test-utils";
import { createClient } from "@libsql/client";
import { createRequire } from "node:module";

// Import drizzle-kit for migrations
const require = createRequire(import.meta.url);
const { generateSQLiteDrizzleJson, generateSQLiteMigration } =
  require("drizzle-kit/api") as typeof import("drizzle-kit/api");

describe("Internal Fragment", () => {
  let adapter: DrizzleAdapter;
  let db: DBType;
  let fragment: ReturnType<typeof instantiateFragment>;

  function instantiateFragment(options: FragnoPublicConfigWithDatabase) {
    return instantiate(internalFragmentDef).withConfig({}).withOptions(options).build();
  }

  beforeAll(async () => {
    const { schemaModule, cleanup } = await writeAndLoadSchema(
      "internal-fragment",
      settingsSchema,
      "sqlite",
      "",
    );

    const client = createClient({
      url: "file::memory:?cache=shared",
    });

    db = drizzle(client, {
      schema: schemaModule,
    }) as unknown as DBType;

    // Generate and run migrations for both schemas
    const emptyJson = await generateSQLiteDrizzleJson({});
    const targetJson = await generateSQLiteDrizzleJson(schemaModule);

    const migrationStatements = await generateSQLiteMigration(emptyJson, targetJson);

    for (const statement of migrationStatements) {
      await client.execute(statement);
    }

    adapter = new DrizzleAdapter({
      db,
      provider: "sqlite",
    });

    // Instantiate fragment with shared database adapter
    const options: FragnoPublicConfigWithDatabase = {
      databaseAdapter: adapter,
    };

    fragment = instantiateFragment(options);

    return async () => {
      client.close();
      await cleanup();
    };
  }, 12000);

  it("should get undefined for non-existent key", async () => {
    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const valuePromise = fragment.services.settingsService.get("test-key");
        await executeRetrieve();
        return await valuePromise;
      });
    });

    expect(result).toBeUndefined();
  });

  it("should set and get a value", async () => {
    await fragment.inContext(async function () {
      return await this.uow(async ({ executeMutate }) => {
        const setPromise = fragment.services.settingsService.set("test-key", "test-value");
        await executeMutate();
        await setPromise;
      });
    });

    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const valuePromise = fragment.services.settingsService.get("test-key");
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
        const setPromise = fragment.services.settingsService.set("test-key", "updated-value");
        await executeMutate();
        await setPromise;
      });
    });

    const result = await fragment.inContext(async function () {
      return await this.uow(async ({ executeRetrieve }) => {
        const valuePromise = fragment.services.settingsService.get("test-key");
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
        const valuePromise = fragment.services.settingsService.get("test-key");
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
        const valuePromise = fragment.services.settingsService.get("test-key");
        await executeRetrieve();
        return await valuePromise;
      });
    });

    expect(result).toBeUndefined();
  });
});
