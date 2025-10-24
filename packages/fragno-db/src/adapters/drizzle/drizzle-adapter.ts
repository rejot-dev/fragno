import type { DatabaseAdapter } from "../adapters";
import { type AnySchema } from "../../schema/create";
import type { AbstractQuery } from "../../query/query";
import type { SchemaGenerator } from "../../schema-generator/schema-generator";
import { generateSchema } from "./generate";
import { fromDrizzle, type DrizzleUOWConfig } from "./drizzle-query";
import { createTableNameMapper, type DBType, type DrizzleResult } from "./shared";
import { createSettingsManager, settingsSchema } from "../../shared/settings-schema";
import { sql } from "drizzle-orm";

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

  async isConnectionHealthy(): Promise<boolean> {
    try {
      const result = (await (this.#drizzleConfig.db as DBType).execute(
        sql`SELECT 1 as healthy`,
      )) as DrizzleResult;
      return result.rows[0]["healthy"] === 1;
    } catch {
      return false;
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
