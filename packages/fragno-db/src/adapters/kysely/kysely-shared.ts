import { Kysely } from "kysely";
import type { SQLProvider } from "../../shared/providers";
import { MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";

/**
 * Maps logical table names (used by fragment authors) to physical table names (with namespace suffix)
 */
export interface TableNameMapper {
  toPhysical(logicalName: string): string;
  toLogical(physicalName: string): string;
}

/**
 * Creates a table name mapper for a given namespace.
 * Physical names have format: {logicalName}_{namespace}
 */
export function createTableNameMapper(namespace: string): TableNameMapper {
  return {
    toPhysical: (logicalName: string) => `${logicalName}_${namespace}`,
    toLogical: (physicalName: string) => {
      if (physicalName.endsWith(`_${namespace}`)) {
        return physicalName.slice(0, -(namespace.length + 1));
      }
      return physicalName;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

/**
 * Creates a Kysely instance that can only build queries, not execute them.
 */
export function createKysely(provider: SQLProvider): KyselyAny {
  // oxlint-disable-next-line no-explicit-any
  const fakeObj = {} as any;
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
      return new Kysely({
        dialect: new PostgresDialect(fakeObj),
      });

    case "mysql":
      return new Kysely({
        dialect: new MysqlDialect(fakeObj),
      });

    case "sqlite":
      return new Kysely({
        dialect: new SqliteDialect(fakeObj),
      });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
