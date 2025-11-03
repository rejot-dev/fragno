import type { DatabaseAdapter } from "../adapters";
import { type AnySchema } from "../../schema/create";
import type { AbstractQuery } from "../../query/query";
import type { SchemaGenerator } from "../../schema-generator/schema-generator";
import { generateSchema } from "./generate";
import { fromDrizzle, type DrizzleUOWConfig } from "./drizzle-query";
import { createTableNameMapper, type DBType, type DrizzleResult } from "./shared";
import { createSettingsManager, settingsSchema } from "../../shared/settings-schema";
import { sql } from "drizzle-orm";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
} from "../adapters";
import type { ConnectionPool } from "../../shared/connection-pool";
import { createDrizzleConnectionPool } from "./drizzle-connection-pool";

export interface DrizzleConfig {
  db: unknown | (() => unknown | Promise<unknown>);
  provider: "sqlite" | "mysql" | "postgresql";
}

export class DrizzleAdapter implements DatabaseAdapter<DrizzleUOWConfig> {
  #connectionPool: ConnectionPool<DBType>;
  #provider: "sqlite" | "mysql" | "postgresql";
  #schemaNamespaceMap = new WeakMap<AnySchema, string>();

  constructor(config: DrizzleConfig) {
    this.#connectionPool = createDrizzleConnectionPool(
      config.db as DBType | (() => DBType | Promise<DBType>),
    );
    this.#provider = config.provider;
  }

  get [fragnoDatabaseAdapterNameFakeSymbol](): string {
    return "drizzle";
  }

  get [fragnoDatabaseAdapterVersionFakeSymbol](): number {
    return 0;
  }

  async close(): Promise<void> {
    await this.#connectionPool.close();
  }

  createTableNameMapper(namespace: string) {
    return createTableNameMapper(namespace);
  }

  get provider(): "sqlite" | "mysql" | "postgresql" {
    return this.#provider;
  }

  async isConnectionHealthy(): Promise<boolean> {
    const conn = await this.#connectionPool.connect();
    try {
      const result = await conn.db.execute(sql`SELECT 1 as healthy`);

      // Handle different result formats across providers
      // PostgreSQL/MySQL: { rows: [...] }
      // SQLite: array directly or { rows: [...] }
      if (Array.isArray(result)) {
        return result.length > 0 && result[0]["healthy"] === 1;
      } else {
        const drizzleResult = result as DrizzleResult;
        return drizzleResult.rows[0]["healthy"] === 1;
      }
    } catch {
      return false;
    } finally {
      await conn.release();
    }
  }

  async getSchemaVersion(namespace: string): Promise<string | undefined> {
    const queryEngine = this.createQueryEngine(settingsSchema, namespace);
    const manager = createSettingsManager(queryEngine, namespace);

    // Try to read the version key directly
    const result = await manager.get("version");
    return result?.value;
  }

  createQueryEngine<TSchema extends AnySchema>(
    schema: TSchema,
    namespace: string,
  ): AbstractQuery<TSchema, DrizzleUOWConfig> {
    // Register schema-namespace mapping
    this.#schemaNamespaceMap.set(schema, namespace);

    // Only create mapper if namespace is non-empty
    const mapper = namespace ? createTableNameMapper(namespace) : undefined;
    return fromDrizzle(
      schema,
      this.#connectionPool,
      this.#provider,
      mapper,
      undefined,
      this.#schemaNamespaceMap,
    );
  }

  createSchemaGenerator(
    fragments: { schema: AnySchema; namespace: string }[],
    options?: { path?: string },
  ): SchemaGenerator {
    return {
      generateSchema: (genOptions) => {
        const path = genOptions?.path ?? options?.path ?? "fragno-schema.ts";

        return {
          schema: generateSchema(fragments, this.#provider),
          path,
        };
      },
    };
  }
}
