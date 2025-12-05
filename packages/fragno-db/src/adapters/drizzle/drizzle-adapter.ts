import type { DatabaseAdapter } from "../adapters";
import { type AnySchema } from "../../schema/create";
import type { SchemaGenerator } from "../../schema-generator/schema-generator";
import { generateSchema } from "./generate";
import { createTableNameMapper } from "../shared/table-name-mapper";

import {
  GenericSQLAdapter,
  type GenericSQLOptions,
  type UnitOfWorkConfig,
} from "../generic-sql/generic-sql-adapter";

export interface DrizzleConfig {
  db: unknown | (() => unknown | Promise<unknown>);
  provider: "sqlite" | "mysql" | "postgresql";
}

export class DrizzleAdapter extends GenericSQLAdapter implements DatabaseAdapter<UnitOfWorkConfig> {
  constructor(options: GenericSQLOptions) {
    super(options);
  }

  override createTableNameMapper(namespace: string) {
    return createTableNameMapper(namespace, false);
  }

  override createSchemaGenerator(
    fragments: { schema: AnySchema; namespace: string }[],
    options?: { path?: string },
  ): SchemaGenerator {
    return {
      generateSchema: (genOptions) => {
        const path = genOptions?.path ?? options?.path ?? "fragno-schema.ts";

        return {
          schema: generateSchema(fragments, this.driverConfig.databaseType, {
            mapperFactory: (ns) => (ns ? this.createTableNameMapper(ns) : undefined),
          }),
          path,
        };
      },
    };
  }
}
