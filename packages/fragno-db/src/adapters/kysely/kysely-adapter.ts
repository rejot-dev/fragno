import { sql, type Kysely } from "kysely";
import type { SQLProvider } from "../../shared/providers";
import type { DatabaseAdapter } from "../adapters";
import { createMigrator, type Migrator } from "../../migration-engine/create";
import type { AnySchema } from "../../schema/create";
import type { CustomOperation, MigrationOperation } from "../../migration-engine/shared";
import { execute } from "./migration/execute";
import type { AbstractQuery } from "../../query/query";
import { fromKysely } from "./kysely-query";
import { createTableNameMapper } from "./kysely-shared";
import { createHash } from "node:crypto";
import { SETTINGS_TABLE_NAME } from "../../shared/settings-schema";

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

  createQueryEngine<T extends AnySchema>(schema: T, namespace: string): AbstractQuery<T> {
    // Only create mapper if namespace is non-empty
    const mapper = namespace ? createTableNameMapper(namespace) : undefined;
    return fromKysely(schema, this.#kyselyConfig, mapper);
  }

  async isConnectionHealthy(): Promise<boolean> {
    try {
      const result = await this.#kyselyConfig.db.executeQuery(
        sql`SELECT 1 as healthy`.compile(this.#kyselyConfig.db),
      );
      return (result.rows[0] as Record<string, unknown>)["healthy"] === 1;
    } catch {
      return false;
    }
  }

  createMigrationEngine(schema: AnySchema, namespace: string): Migrator {
    const manager = createSettingsManager(this.#kyselyConfig.db, namespace);
    const mapper = namespace ? createTableNameMapper(namespace) : undefined;

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
        execute(op, this.#kyselyConfig, (node) => onCustomNode(node, db), mapper),
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
          return [
            {
              type: "custom",
              sql:
                fromVersion === 0
                  ? manager.insert(`schema_version`, toVersion.toString())
                  : manager.update(`schema_version`, toVersion.toString()),
            },
          ];
        },
      },
    });

    return migrator;
  }

  getSchemaVersion(namespace: string) {
    const manager = createSettingsManager(this.#kyselyConfig.db, namespace);

    return manager.get(`schema_version`);
  }
}

function createSettingsManager(db: KyselyAny, namespace: string) {
  // Settings table is never namespaced, but keys include namespace prefix
  const tableName = SETTINGS_TABLE_NAME;

  return {
    async get(key: string): Promise<string | undefined> {
      try {
        const result = await db
          .selectFrom(tableName)
          .where("key", "=", sql.lit(`${namespace}.${key}`))
          .select(["value"])
          .executeTakeFirstOrThrow();
        return result.value as string;
      } catch {
        return;
      }
    },

    insert(key: string, value: string) {
      return db
        .insertInto(tableName)
        .values({
          id: sql.lit(
            createHash("md5").update(`${namespace}.${key}`).digest("base64url").replace(/=/g, ""),
          ),
          key: sql.lit(`${namespace}.${key}`),
          value: sql.lit(value),
        })
        .compile().sql;
    },

    update(key: string, value: string) {
      return db
        .updateTable(tableName)
        .set({
          value: sql.lit(value),
        })
        .where("key", "=", sql.lit(`${namespace}.${key}`))
        .compile().sql;
    },
  };
}
