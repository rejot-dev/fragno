export const supportedDatabases = ["sqlite", "postgresql", "mysql"] as const;
export type SupportedDatabase = (typeof supportedDatabases)[number];

export const supportedDriverTypes = [
  "sqlocal",
  "cloudflare_durable_objects",
  "better-sqlite3",
  "pg",
  "pglite",
  "mysql2",
] as const;

export type SupportedDriverType = (typeof supportedDriverTypes)[number];

export abstract class DriverConfig<T extends SupportedDriverType = SupportedDriverType> {
  abstract readonly driverType: T;
  abstract readonly databaseType: SupportedDatabase;

  abstract readonly supportsReturning: boolean;
  abstract readonly supportsJson: boolean;

  /**
   * Column name for internal ID in RETURNING results.
   * Only defined if supportsReturning is true.
   */
  abstract readonly internalIdColumn: string | undefined;

  get supportsRowsAffected(): boolean {
    return !!this.extractAffectedRows;
  }

  /**
   * Extract the number of affected rows from a query result.
   * Only implemented for drivers that support affected rows reporting.
   *
   * @param result - The query result from the SQL driver
   * @returns The number of affected rows as bigint
   * @throws Error if affected rows information is not found in the result
   */
  extractAffectedRows?(result: Record<string, unknown>): bigint;
}

export class SQLocalDriverConfig extends DriverConfig<"sqlocal"> {
  override readonly driverType = "sqlocal";
  override readonly databaseType = "sqlite";
  override readonly supportsReturning = true;
  override readonly supportsJson = false;
  override readonly internalIdColumn = "_internalId";
}

export class CloudflareDurableObjectsDriverConfig extends DriverConfig<"cloudflare_durable_objects"> {
  override readonly driverType = "cloudflare_durable_objects";
  override readonly databaseType = "sqlite";
  override readonly supportsReturning = true;
  override readonly supportsJson = false;
  override readonly internalIdColumn = "_internalId";
}

export class BetterSQLite3DriverConfig extends DriverConfig<"better-sqlite3"> {
  override readonly driverType = "better-sqlite3";
  override readonly databaseType = "sqlite";
  override readonly supportsReturning = true;
  override readonly supportsJson = false;
  override readonly internalIdColumn = "_internalId";

  override extractAffectedRows(result: Record<string, unknown>): bigint {
    if ("numAffectedRows" in result) {
      const value = result["numAffectedRows"];
      if (typeof value === "bigint") {
        return value;
      }
      if (typeof value === "number") {
        return BigInt(value);
      }
    }

    throw new Error(
      `No affected rows found in result: ${JSON.stringify(result)}. Driver ${this.driverType} is expected to support affected rows.`,
    );
  }
}

export class NodePostgresDriverConfig extends DriverConfig<"pg"> {
  override readonly driverType = "pg";
  override readonly databaseType = "postgresql";
  override readonly supportsReturning = true;
  override readonly supportsJson = true;
  override readonly internalIdColumn = "_internalId";

  override extractAffectedRows(result: Record<string, unknown>): bigint {
    if ("numAffectedRows" in result) {
      const value = result["numAffectedRows"];
      if (typeof value === "bigint") {
        return value;
      }
      if (typeof value === "number") {
        return BigInt(value);
      }
    }
    if ("numChangedRows" in result) {
      const value = result["numChangedRows"];
      if (typeof value === "bigint") {
        return value;
      }
      if (typeof value === "number") {
        return BigInt(value);
      }
    }
    throw new Error(
      `No affected rows found in result: ${JSON.stringify(result)}. Driver ${this.driverType} is expected to support affected rows.`,
    );
  }
}

export class PGLiteDriverConfig extends DriverConfig<"pglite"> {
  override readonly driverType = "pglite";
  override readonly databaseType = "postgresql";
  override readonly supportsReturning = true;
  override readonly supportsJson = true;
  override readonly internalIdColumn = "_internalId";

  override extractAffectedRows(result: Record<string, unknown>): bigint {
    if ("affectedRows" in result) {
      const value = result["affectedRows"];
      if (typeof value === "bigint") {
        return value;
      }
      if (typeof value === "number") {
        return BigInt(value);
      }
    }
    throw new Error(
      `No affected rows found in result: ${JSON.stringify(result)}. Driver ${this.driverType} is expected to support affected rows.`,
    );
  }
}

export class MySQL2DriverConfig extends DriverConfig<"mysql2"> {
  override readonly driverType = "mysql2";
  override readonly databaseType = "mysql";
  override readonly supportsReturning = false;
  override readonly supportsJson = true;
  override readonly internalIdColumn = undefined;
}
