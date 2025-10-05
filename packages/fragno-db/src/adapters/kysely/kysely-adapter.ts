import { sql, type Kysely } from "kysely";
import type { SQLProvider } from "../../shared/providers";
import type { DatabaseAdapter } from "../adapters";
import { schemaToDBType } from "../../schema/serialize";
import { createMigrator, type Migrator } from "../../migration-engine/create";
import type { AnySchema } from "../../schema/create";
import type { CustomOperation, MigrationOperation } from "../../migration-engine/shared";
import { execute } from "./migration/execute";

const SETTINGS_TABLE_NAME = "fragno_db_settings" as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

export interface KyselyConfig {
  db: KyselyAny;
  provider: SQLProvider;
  namespace: string;
}

export class KyselyAdapter implements DatabaseAdapter {
  #kyselyConfig: KyselyConfig;

  constructor(config: KyselyConfig) {
    this.#kyselyConfig = config;
  }

  createMigrationEngine(schema: AnySchema): Migrator {
    const manager = createSettingsManager(
      this.#kyselyConfig.db,
      this.#kyselyConfig.provider,
      SETTINGS_TABLE_NAME,
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

    return createMigrator({
      schema,
      userConfig: {
        provider: this.#kyselyConfig.provider,
      },
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
          const v = await manager.get(`${this.#kyselyConfig.namespace}.schema_version`);
          return v ? parseInt(v) : 0;
        },
        updateSettingsInMigration: async (version) => {
          const init = await manager.initIfNeeded();

          if (init) {
            return [
              { type: "custom", sql: init },
              { type: "custom", sql: `UPDATE ${SETTINGS_TABLE_NAME} SET version = ${version}` },
            ];
          }

          return [
            { type: "custom", sql: `UPDATE ${SETTINGS_TABLE_NAME} SET version = ${version}` },
          ];
        },
      },
    });
  }

  getSchemaVersion() {
    const manager = createSettingsManager(
      this.#kyselyConfig.db,
      this.#kyselyConfig.provider,
      SETTINGS_TABLE_NAME,
    );

    return manager.get(`${this.#kyselyConfig.namespace}.schema_version`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createSettingsManager(db: Kysely<any>, provider: SQLProvider, settingsTableName: string) {
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
          .where("key", "=", key)
          .select(["value"])
          .executeTakeFirstOrThrow();
        return result.value as string;
      } catch {
        return;
      }
    },

    async initIfNeeded() {
      const tables = await db.introspection.getTables();
      if (tables.some((table) => table.name === settingsTableName)) {
        return;
      }

      return initTable().compile().sql;
    },

    insert(key: string, value: string) {
      return db
        .insertInto(settingsTableName)
        .values({
          key: sql.lit(key),
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
        .where("key", "=", sql.lit(key))
        .compile().sql;
    },
  };
}
