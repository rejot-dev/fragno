import type { DatabaseAdapter } from "../adapters";
import type { AnySchema } from "../../schema/create";
import type { SchemaGenerator } from "../../schema-generator/schema-generator";
import { generateSchema } from "./generate";
import { createTableNameMapper } from "../shared/table-name-mapper";
import {
  GenericSQLAdapter,
  type GenericSQLOptions,
  type UnitOfWorkConfig,
} from "../generic-sql/generic-sql-adapter";
import { sqliteStoragePrisma } from "../generic-sql/sqlite-storage";

export class PrismaAdapter extends GenericSQLAdapter implements DatabaseAdapter<UnitOfWorkConfig> {
  constructor(options: GenericSQLOptions) {
    super({
      ...options,
      sqliteStorageMode: options.sqliteStorageMode ?? sqliteStoragePrisma,
    });
  }

  override createTableNameMapper(namespace: string) {
    return createTableNameMapper(namespace, false);
  }

  createSchemaGenerator(
    fragments: { schema: AnySchema; namespace: string }[],
    options?: { path?: string },
  ): SchemaGenerator {
    return {
      generateSchema: (genOptions) => {
        const path = genOptions?.path ?? options?.path ?? "fragno.prisma";

        return {
          schema: generateSchema(fragments, this.driverConfig.databaseType, {
            sqliteStorageMode: this.sqliteStorageMode,
          }),
          path,
        };
      },
    };
  }
}
