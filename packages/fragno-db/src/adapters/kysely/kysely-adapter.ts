import { sql, type Kysely } from "kysely";
import type { SQLProvider } from "../../shared/providers";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
  type DatabaseAdapter,
} from "../adapters";
import { createMigrator, type Migrator } from "../../migration-engine/create";
import type { AnySchema } from "../../schema/create";
import type { CustomOperation, MigrationOperation } from "../../migration-engine/shared";
import { execute, preprocessOperations } from "./migration/execute";
import type { AbstractQuery } from "../../query/query";
import { fromKysely } from "./kysely-query";
import { createTableNameMapper } from "./kysely-shared";
import { createHash } from "node:crypto";
import { SETTINGS_TABLE_NAME } from "../../shared/settings-schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

export interface KyselyConfig {
  db: KyselyAny | (() => KyselyAny);
  provider: SQLProvider;
}

export class KyselyAdapter implements DatabaseAdapter {
  #kyselyConfig: KyselyConfig;

  constructor(config: KyselyConfig) {
    this.#kyselyConfig = config;
  }

  get [fragnoDatabaseAdapterNameFakeSymbol](): string {
    return "kysely";
  }

  get [fragnoDatabaseAdapterVersionFakeSymbol](): number {
    return 0;
  }

  async close(): Promise<void> {
    const db = this.#getDb();
    await db.destroy();
  }

  #getDb(): KyselyAny {
    const db = this.#kyselyConfig.db;
    return typeof db === "function" ? db() : db;
  }

  createQueryEngine<T extends AnySchema>(schema: T, namespace: string): AbstractQuery<T> {
    // Only create mapper if namespace is non-empty
    const mapper = namespace ? createTableNameMapper(namespace) : undefined;
    // Resolve the db instance if it's a function
    const resolvedConfig: KyselyConfig = {
      db: this.#getDb(),
      provider: this.#kyselyConfig.provider,
    };
    return fromKysely(schema, resolvedConfig, mapper);
  }

  async isConnectionHealthy(): Promise<boolean> {
    try {
      const db = this.#getDb();
      const result = await db.executeQuery(sql`SELECT 1 as healthy`.compile(db));
      return (result.rows[0] as Record<string, unknown>)["healthy"] === 1;
    } catch {
      return false;
    }
  }

  createMigrationEngine(schema: AnySchema, namespace: string): Migrator {
    const manager = createSettingsManager(this.#getDb(), namespace);
    const mapper = namespace ? createTableNameMapper(namespace) : undefined;

    const preprocessMigrationOperations = (operations: MigrationOperation[]) => {
      let preprocessed = preprocessOperations(operations, this.#kyselyConfig);

      if (this.#kyselyConfig.provider === "mysql") {
        preprocessed.unshift({ type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 0" });
        preprocessed.push({ type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 1" });
      }

      return preprocessed;
    };

    // Convert operations to executable nodes bound to specific db instance
    const toExecutableNodes = (operations: MigrationOperation[], db: KyselyAny) => {
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

      const dbConfig: KyselyConfig = { db, provider: this.#kyselyConfig.provider };
      return operations.flatMap((op) =>
        execute(op, dbConfig, (node) => onCustomNode(node, db), mapper),
      );
    };

    const migrator = createMigrator({
      schema,
      executor: async (operations) => {
        const db = this.#getDb();
        // For SQLite, execute PRAGMA defer_foreign_keys BEFORE transaction
        if (this.#kyselyConfig.provider === "sqlite") {
          await sql.raw("PRAGMA defer_foreign_keys = ON").execute(db);
        }

        await db.transaction().execute(async (tx) => {
          const preprocessed = preprocessMigrationOperations(operations);
          const nodes = toExecutableNodes(preprocessed, tx);
          for (const node of nodes) {
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
          const parts: string[] = [];

          // Add SQLite PRAGMA at the beginning
          if (this.#kyselyConfig.provider === "sqlite") {
            parts.push("PRAGMA defer_foreign_keys = ON;");
          }

          const preprocessed = preprocessMigrationOperations(operations);
          const nodes = toExecutableNodes(preprocessed, this.#getDb());
          const compiled = nodes.map((node) => `${node.compile().sql};`);

          parts.push(...compiled);

          return parts.join("\n\n");
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
    const manager = createSettingsManager(this.#getDb(), namespace);

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
