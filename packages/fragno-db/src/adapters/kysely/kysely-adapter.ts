import { sql, type Kysely } from "kysely";
import type { SQLProvider } from "../../shared/providers";
import type { DatabaseAdapter } from "../adapters";
import { schemaToDBType } from "../../schema/serialize";
import { createMigrator, type Migrator } from "../../migration-engine/create";
import type { AnySchema } from "../../schema/create";
import type { CustomOperation, MigrationOperation } from "../../migration-engine/shared";
import { execute } from "./migration/execute";
import type { AbstractQuery } from "../../query/query";
import { fromKysely } from "./kysely-query";

const SETTINGS_TABLE_NAME = "fragno_db_settings" as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

export interface KyselyConfig {
  db: KyselyAny;
  provider: SQLProvider;
}

export class KyselyAdapter implements DatabaseAdapter {
  #kyselyConfig: KyselyConfig;

  constructor(config: KyselyConfig) {
    this.#kyselyConfig = config;
  }

  createQueryEngine<T extends AnySchema>(schema: T, _namespace: string): AbstractQuery<T> {
    return fromKysely(schema, this.#kyselyConfig);
  }

  createMigrationEngine(schema: AnySchema, namespace: string): Migrator {
    const manager = createSettingsManager(
      this.#kyselyConfig.db,
      this.#kyselyConfig.provider,
      SETTINGS_TABLE_NAME,
      namespace,
    );

    const onCustomNode = (node: CustomOperation, db: KyselyAny) => {
      const statement = sql.raw(node["sql"] as string);

      return {
        compile() {
          return statement.compile(db);
        },
        execute() {
          return statement.execute(db);
        },
      };
    };

    const preprocess = (operations: MigrationOperation[], db: KyselyAny) => {
      if (this.#kyselyConfig.provider === "mysql") {
        operations.unshift({ type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 0" });
        operations.push({ type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 1" });
      } else if (this.#kyselyConfig.provider === "sqlite") {
        operations.unshift({
          type: "custom",
          sql: "PRAGMA defer_foreign_keys = ON",
        });
      }

      return operations.flatMap((op) =>
        execute(op, this.#kyselyConfig, (node) => onCustomNode(node, db)),
      );
    };

    const migrator = createMigrator({
      schema,
      executor: async (operations) => {
        await this.#kyselyConfig.db.transaction().execute(async (tx) => {
          for (const node of preprocess(operations, tx)) {
            try {
              await node.execute();
            } catch (e) {
              console.error("failed at", node.compile(), e);
              throw e;
            }
          }
        });
      },
      sql: {
        toSql: (operations) => {
          const compiled = preprocess(operations, this.#kyselyConfig.db).map(
            (m) => `${m.compile().sql};`,
          );

          return compiled.join("\n\n");
        },
      },

      settings: {
        getVersion: async () => {
          const v = await manager.get(`schema_version`);
          return v ? parseInt(v) : 0;
        },
        updateSettingsInMigration: async (fromVersion, toVersion) => {
          // Only create the settings table if we're migrating from version 0
          if (fromVersion === 0) {
            return [
              { type: "custom", sql: manager.initTable() },
              {
                type: "custom",
                sql: manager.insert(`schema_version`, toVersion.toString()),
              },
            ];
          }

          return [
            {
              type: "custom",
              sql: manager.update(`schema_version`, toVersion.toString()),
            },
          ];
        },
      },
    });

    // Add getDefaultFileName implementation
    migrator.getDefaultFileName = (namespace: string, fromVersion: number, toVersion: number) => {
      const date = new Date().toISOString().split("T")[0].replace(/-/g, "");
      const safeName = namespace.replace(/[^a-z0-9-]/gi, "_");
      return `${date}_${safeName}_migration_${fromVersion}_to_${toVersion}.sql`;
    };

    return migrator;
  }

  getSchemaVersion(namespace: string) {
    const manager = createSettingsManager(
      this.#kyselyConfig.db,
      this.#kyselyConfig.provider,
      SETTINGS_TABLE_NAME,
      namespace,
    );

    return manager.get(`schema_version`);
  }
}

function createSettingsManager(
  db: KyselyAny,
  provider: SQLProvider,
  settingsTableName: string,
  namespace: string,
) {
  function initTable() {
    return db.schema
      .createTable(settingsTableName)
      .addColumn("key", provider === "sqlite" ? "text" : "varchar(255)", (col) => col.primaryKey())
      .addColumn("value", sql.raw(schemaToDBType({ type: "string" }, provider)), (col) =>
        col.notNull(),
      );
  }

  return {
    async get(key: string): Promise<string | undefined> {
      try {
        const result = await db
          .selectFrom(settingsTableName)
          .where("key", "=", sql.lit(`${namespace}.${key}`))
          .select(["value"])
          .executeTakeFirstOrThrow();
        return result.value as string;
      } catch {
        return;
      }
    },

    initTable() {
      return initTable().compile().sql;
    },

    insert(key: string, value: string) {
      return db
        .insertInto(settingsTableName)
        .values({
          key: sql.lit(`${namespace}.${key}`),
          value: sql.lit(value),
        })
        .compile().sql;
    },

    update(key: string, value: string) {
      return db
        .updateTable(settingsTableName)
        .set({
          value: sql.lit(value),
        })
        .where("key", "=", sql.lit(`${namespace}.${key}`))
        .compile().sql;
    },
  };
}
