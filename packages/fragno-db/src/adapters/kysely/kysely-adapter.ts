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
import { fromKysely, type KyselyUOWConfig } from "./kysely-query";
import { createTableNameMapper } from "./kysely-shared";
import { createHash } from "node:crypto";
import { SETTINGS_TABLE_NAME } from "../../shared/settings-schema";
import type { ConnectionPool } from "../../shared/connection-pool";
import { createKyselyConnectionPool } from "./kysely-connection-pool";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

export interface KyselyConfig {
  db: KyselyAny | (() => KyselyAny | Promise<KyselyAny>);
  provider: SQLProvider;
}

export class KyselyAdapter implements DatabaseAdapter<KyselyUOWConfig> {
  #connectionPool: ConnectionPool<KyselyAny>;
  #provider: SQLProvider;

  constructor(config: KyselyConfig) {
    this.#connectionPool = createKyselyConnectionPool(config.db);
    this.#provider = config.provider;
  }

  get [fragnoDatabaseAdapterNameFakeSymbol](): string {
    return "kysely";
  }

  get [fragnoDatabaseAdapterVersionFakeSymbol](): number {
    return 0;
  }

  async close(): Promise<void> {
    await this.#connectionPool.close();
  }

  createQueryEngine<T extends AnySchema>(
    schema: T,
    namespace: string,
  ): AbstractQuery<T, KyselyUOWConfig> {
    // Only create mapper if namespace is non-empty
    const mapper = namespace ? createTableNameMapper(namespace) : undefined;
    return fromKysely(schema, this.#connectionPool, this.#provider, mapper);
  }

  async isConnectionHealthy(): Promise<boolean> {
    const conn = await this.#connectionPool.connect();
    try {
      const result = await conn.db.executeQuery(sql`SELECT 1 as healthy`.compile(conn.db));
      return (result.rows[0] as Record<string, unknown>)["healthy"] === 1;
    } catch {
      return false;
    } finally {
      await conn.release();
    }
  }

  createMigrationEngine(schema: AnySchema, namespace: string): Migrator {
    const mapper = namespace ? createTableNameMapper(namespace) : undefined;

    const preprocessMigrationOperations = (operations: MigrationOperation[], db: KyselyAny) => {
      // Preprocess operations using the provided db instance
      const config: KyselyConfig = {
        db,
        provider: this.#provider,
      };
      let preprocessed = preprocessOperations(operations, config);

      if (this.#provider === "mysql") {
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

      const config: KyselyConfig = { db, provider: this.#provider };
      return operations.flatMap((op) =>
        execute(op, config, (node) => onCustomNode(node, db), mapper),
      );
    };

    const migrator = createMigrator({
      schema,
      executor: async (operations) => {
        const conn = await this.#connectionPool.connect();
        try {
          // For SQLite, execute PRAGMA defer_foreign_keys BEFORE transaction
          if (this.#provider === "sqlite") {
            await sql.raw("PRAGMA defer_foreign_keys = ON").execute(conn.db);
          }

          await conn.db.transaction().execute(async (tx) => {
            // Use the transaction instance for both preprocessing and execution
            const preprocessed = preprocessMigrationOperations(operations, tx);
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
        } finally {
          await conn.release();
        }
      },
      sql: {
        toSql: (operations) => {
          const parts: string[] = [];

          // Add SQLite PRAGMA at the beginning
          if (this.#provider === "sqlite") {
            parts.push("PRAGMA defer_foreign_keys = ON;");
          }

          // Use getDatabaseSync for SQL generation (doesn't execute, just builds SQL strings)
          const db = this.#connectionPool.getDatabaseSync();
          const preprocessed = preprocessMigrationOperations(operations, db);
          const nodes = toExecutableNodes(preprocessed, db);
          const compiled = nodes.map((node) => `${node.compile().sql};`);

          parts.push(...compiled);

          return parts.join("\n\n");
        },
      },

      settings: {
        getVersion: async () => {
          const conn = await this.#connectionPool.connect();
          try {
            const manager = createSettingsManager(conn.db, namespace);
            const v = await manager.get(`schema_version`);
            return v ? parseInt(v) : 0;
          } finally {
            await conn.release();
          }
        },
        updateSettingsInMigration: async (fromVersion, toVersion) => {
          const conn = await this.#connectionPool.connect();
          try {
            const manager = createSettingsManager(conn.db, namespace);
            return [
              {
                type: "custom",
                sql:
                  fromVersion === 0
                    ? manager.insert(`schema_version`, toVersion.toString())
                    : manager.update(`schema_version`, toVersion.toString()),
              },
            ];
          } finally {
            await conn.release();
          }
        },
      },
    });

    return migrator;
  }

  async getSchemaVersion(namespace: string): Promise<string | undefined> {
    const conn = await this.#connectionPool.connect();
    try {
      const manager = createSettingsManager(conn.db, namespace);
      return await manager.get(`schema_version`);
    } finally {
      await conn.release();
    }
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
