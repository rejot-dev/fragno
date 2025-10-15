import type { DatabaseAdapter } from "../adapters";
import { column, idColumn, schema, SchemaBuilder, type AnySchema } from "../../schema/create";
import type { AbstractQuery } from "../../query/query";
import type { SchemaGenerator } from "../../schema-generator/schema-generator";
import { generateSchema } from "./generate";
import { fromDrizzle } from "./drizzle-query";

const SETTINGS_TABLE_NAME = "fragno_db_settings" as const;

export interface DrizzleConfig {
  db: unknown;
  provider: "sqlite" | "mysql" | "postgresql";
}

export class DrizzleAdapter implements DatabaseAdapter {
  #drizzleConfig: DrizzleConfig;

  constructor(config: DrizzleConfig) {
    this.#drizzleConfig = config;
  }

  #createFullSchema<T extends AnySchema>(schema: T) {
    return new SchemaBuilder()
      .mergeWithExistingSchema(schema)
      .mergeWithExistingSchema(createSettingsSchema(schema.version))
      .build();
  }

  async getSchemaVersion(namespace: string): Promise<string | undefined> {
    const queryEngine = this.createQueryEngine(createSettingsSchema(0), namespace);
    return createSettingsManager(queryEngine, namespace).get(`schema_version`);
  }

  createQueryEngine<T extends AnySchema>(schema: T, _namespace: string): AbstractQuery<T> {
    return fromDrizzle(schema, this.#drizzleConfig);
  }

  createSchemaGenerator(schema: AnySchema, namespace: string): SchemaGenerator {
    return {
      generateSchema: (options) => {
        const path = options?.path ?? `drizzle-schema-${namespace}.ts`;

        const schemaWithSettingsTable = this.#createFullSchema(schema);

        return {
          schema: generateSchema(schemaWithSettingsTable, this.#drizzleConfig.provider),
          path,
        };
      },
    };
  }
}

function createSettingsSchema(version: number) {
  return schema((s) => {
    return s.addTable(SETTINGS_TABLE_NAME, (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("key", column("string"))
        .addColumn("value", column("string").defaultTo(String(version)))
        .createIndex("unique_key", ["key"], { unique: true });
    });
  });
}

function createSettingsManager(
  queryEngine: AbstractQuery<ReturnType<typeof createSettingsSchema>>,
  namespace: string,
) {
  return {
    async createKeyWithDefault(key: string) {
      const writeUow = queryEngine
        .createUnitOfWork("createKeyWithDefault")
        .create(SETTINGS_TABLE_NAME, {
          key: `${namespace}.${key}`,
        });
      const { success } = await writeUow.executeMutations();
      if (!success) {
        throw new Error("Failed to create key with default");
      }

      return this.get(key);
    },

    get: async (key: string): Promise<string | undefined> => {
      const uow = queryEngine
        .createUnitOfWork("getSettings")
        .find(SETTINGS_TABLE_NAME, (b) =>
          b.whereIndex("unique_key", (eb) => eb("key", "=", `${namespace}.${key}`)),
        );
      const [[result]] = await uow.executeRetrieve();
      return result.value; // FIXME: result should be maybe undefined
    },
  };
}
