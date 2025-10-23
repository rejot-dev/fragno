import type { DatabaseAdapter } from "../adapters";
import { column, idColumn, schema, type AnySchema, type FragnoId } from "../../schema/create";
import type { AbstractQuery } from "../../query/query";
import type { SchemaGenerator } from "../../schema-generator/schema-generator";
import { generateSchema } from "./generate";
import { fromDrizzle, type DrizzleUOWConfig } from "./drizzle-query";
import { createTableNameMapper } from "./shared";

const SETTINGS_TABLE_NAME = "fragno_db_settings" as const;

export interface DrizzleConfig {
  db: unknown;
  provider: "sqlite" | "mysql" | "postgresql";
}

export class DrizzleAdapter implements DatabaseAdapter<DrizzleUOWConfig> {
  #drizzleConfig: DrizzleConfig;

  constructor(config: DrizzleConfig) {
    this.#drizzleConfig = config;
  }

  get provider(): "sqlite" | "mysql" | "postgresql" {
    return this.#drizzleConfig.provider;
  }

  async getSchemaVersion(namespace: string): Promise<string | undefined> {
    const queryEngine = this.createQueryEngine(createSettingsSchema(), namespace);
    const manager = createSettingsManager(queryEngine, namespace);

    // Try to read the version key directly
    const result = await manager.get("version");
    return result?.value;
  }

  createQueryEngine<TSchema extends AnySchema>(
    schema: TSchema,
    namespace: string,
  ): AbstractQuery<TSchema, DrizzleUOWConfig> {
    // Only create mapper if namespace is non-empty
    const mapper = namespace ? createTableNameMapper(namespace) : undefined;
    return fromDrizzle(schema, this.#drizzleConfig, mapper);
  }

  createSchemaGenerator(
    fragments: { schema: AnySchema; namespace: string }[],
    options?: { path?: string },
  ): SchemaGenerator {
    return {
      generateSchema: (genOptions) => {
        const path = genOptions?.path ?? options?.path ?? "fragno-schema.ts";

        return {
          schema: generateSchema(fragments, this.#drizzleConfig.provider),
          path,
        };
      },
    };
  }
}

function createSettingsSchema() {
  return schema((s) => {
    return s.addTable(SETTINGS_TABLE_NAME, (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("key", column("string"))
        .addColumn("value", column("string"))
        .createIndex("unique_key", ["key"], { unique: true });
    });
  });
}

function createSettingsManager(
  queryEngine: AbstractQuery<ReturnType<typeof createSettingsSchema>, DrizzleUOWConfig>,
  namespace: string,
) {
  return {
    async get(key: string): Promise<{ id: FragnoId; key: string; value: string } | undefined> {
      const uow = queryEngine
        .createUnitOfWork()
        .find(SETTINGS_TABLE_NAME, (b) =>
          b.whereIndex("unique_key", (eb) => eb("key", "=", `${namespace}.${key}`)),
        );
      const [[result]] = await uow.executeRetrieve();
      return result; // Safe: result can be undefined if key doesn't exist
    },

    async set(key: string, value: string) {
      const uow = queryEngine
        .createUnitOfWork("createSettingsManager#set")
        .find(SETTINGS_TABLE_NAME, (b) =>
          b.whereIndex("unique_key", (eb) => eb("key", "=", `${namespace}.${key}`)),
        );
      const [[existing]] = await uow.executeRetrieve();

      if (existing) {
        uow.update(SETTINGS_TABLE_NAME, existing.id, (b) => b.set({ value }).check());
      } else {
        uow.create(SETTINGS_TABLE_NAME, {
          key: `${namespace}.${key}`,
          value,
        });
      }

      const { success } = await uow.executeMutations();

      if (!success) {
        throw new Error("Failed to set schema version");
      }
    },

    async delete(id: FragnoId) {
      await queryEngine.delete(SETTINGS_TABLE_NAME, id);
    },
  };
}
