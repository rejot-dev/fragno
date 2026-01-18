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
import { DriverConfig } from "../generic-sql/driver-config";

function applySQLiteProfileDefault(driverConfig: DriverConfig): DriverConfig {
  if (driverConfig.databaseType !== "sqlite") {
    return driverConfig;
  }

  const proto = Object.getPrototypeOf(driverConfig);
  const baseDescriptor = Object.getOwnPropertyDescriptor(DriverConfig.prototype, "sqliteProfile");
  const overrideDescriptor = Object.getOwnPropertyDescriptor(proto, "sqliteProfile");
  const hasOverride = overrideDescriptor?.get && overrideDescriptor.get !== baseDescriptor?.get;

  if (hasOverride) {
    return driverConfig;
  }

  return new Proxy(driverConfig, {
    get(target, prop, receiver) {
      if (prop === "sqliteProfile") {
        return "prisma" as const;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as DriverConfig;
}

export class PrismaAdapter extends GenericSQLAdapter implements DatabaseAdapter<UnitOfWorkConfig> {
  constructor(options: GenericSQLOptions) {
    super({
      ...options,
      driverConfig: applySQLiteProfileDefault(options.driverConfig),
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
            sqliteProfile: this.driverConfig.sqliteProfile,
          }),
          path,
        };
      },
    };
  }
}
