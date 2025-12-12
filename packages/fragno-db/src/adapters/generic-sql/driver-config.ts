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
  abstract readonly supportsRowsAffected: boolean;
  abstract readonly supportsJson: boolean;
}

export class SQLocalDriverConfig extends DriverConfig<"sqlocal"> {
  override readonly driverType = "sqlocal";
  override readonly databaseType = "sqlite";
  override readonly supportsReturning = true;
  override readonly supportsRowsAffected = false;
  override readonly supportsJson = false;
}

export class CloudflareDurableObjectsDriverConfig extends DriverConfig<"cloudflare_durable_objects"> {
  override readonly driverType = "cloudflare_durable_objects";
  override readonly databaseType = "sqlite";
  override readonly supportsReturning = true;
  override readonly supportsRowsAffected = false;
  override readonly supportsJson = false;
}

export class BetterSQLite3DriverConfig extends DriverConfig<"better-sqlite3"> {
  override readonly driverType = "better-sqlite3";
  override readonly databaseType = "sqlite";
  override readonly supportsReturning = true;
  override readonly supportsRowsAffected = true;
  override readonly supportsJson = false;
}

export class NodePostgresDriverConfig extends DriverConfig<"pg"> {
  override readonly driverType = "pg";
  override readonly databaseType = "postgresql";
  override readonly supportsReturning = true;
  override readonly supportsRowsAffected = true;
  override readonly supportsJson = true;
}

export class PGLiteDriverConfig extends DriverConfig<"pglite"> {
  override readonly driverType = "pglite";
  override readonly databaseType = "postgresql";
  override readonly supportsReturning = true;
  override readonly supportsRowsAffected = false;
  override readonly supportsJson = true;
}

export class MySQL2DriverConfig extends DriverConfig<"mysql2"> {
  override readonly driverType = "mysql2";
  override readonly databaseType = "mysql";
  override readonly supportsReturning = false;
  override readonly supportsRowsAffected = false;
  override readonly supportsJson = true;
}
