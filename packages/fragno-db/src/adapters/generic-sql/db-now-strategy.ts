import { sql as kyselySql } from "kysely";
import type { AnyColumn } from "../../schema/create";
import type { DriverConfig, SupportedDatabase } from "./driver-config";
import { sqliteStorageDefault, type SQLiteStorageMode } from "./sqlite-storage";
import { sql as driverSql } from "../../sql-driver/sql";

export type DbNowContext = "mutation" | "query";

export type DbNowExpressionOptions = {
  offsetMs: number;
  context: DbNowContext;
  columnType?: AnyColumn["type"];
  sqliteStorageMode?: SQLiteStorageMode;
};

export type DbNowExpression = ReturnType<typeof kyselySql>;
export type DbNowPreludeStatement = ReturnType<typeof driverSql>;

export type DbNowStrategy = {
  databaseType: SupportedDatabase;
  expression: (options: DbNowExpressionOptions) => DbNowExpression;
  preludeStatements?: () => DbNowPreludeStatement[];
};

export const SQLITE_NOW_TABLE = "__fragno_now";
export const SQLITE_NOW_COLUMNS = {
  epochMs: "ts_epoch_ms",
  text: "ts_text",
} as const;

const formatSecondsModifier = (offsetMs: number): string => {
  const seconds = offsetMs / 1000;
  return `${seconds >= 0 ? "+" : ""}${seconds} seconds`;
};

const sqliteStatementEpochNow = (): DbNowExpression =>
  kyselySql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`;

const sqliteTempEpochNow = (): DbNowExpression =>
  kyselySql`(SELECT ts_epoch_ms FROM __fragno_now LIMIT 1)`;

const sqliteTempTextNow = (): DbNowExpression =>
  kyselySql`(SELECT ts_text FROM __fragno_now LIMIT 1)`;

export const sqliteNowPreludeStatements = (): DbNowPreludeStatement[] => [
  driverSql`
    CREATE TEMP TABLE IF NOT EXISTS __fragno_now (
      ts_epoch_ms INTEGER NOT NULL,
      ts_text TEXT NOT NULL
    );
  `,
  driverSql`DELETE FROM __fragno_now;`,
  driverSql`
    INSERT INTO __fragno_now (ts_epoch_ms, ts_text)
    VALUES (
      cast((julianday('now') - 2440587.5) * 86400000 as integer),
      CURRENT_TIMESTAMP
    );
  `,
];

export const sqliteNowExpression = (options: DbNowExpressionOptions): DbNowExpression => {
  const storageMode = options.sqliteStorageMode ?? sqliteStorageDefault;
  const columnType = options.columnType;
  const isDateLike = columnType === "timestamp" || columnType === "date";
  const storage = columnType === "date" ? storageMode.dateStorage : storageMode.timestampStorage;
  const { offsetMs } = options;

  if (options.context === "mutation") {
    if (isDateLike && storage === "epoch-ms") {
      const base = sqliteTempEpochNow();
      return offsetMs === 0 ? base : kyselySql`${base} + ${offsetMs}`;
    }

    const base = sqliteTempTextNow();
    if (offsetMs === 0) {
      return base;
    }
    const modifier = formatSecondsModifier(offsetMs);
    return kyselySql`datetime(${base}, ${modifier})`;
  }

  if (isDateLike && storage === "epoch-ms") {
    const base = sqliteStatementEpochNow();
    return offsetMs === 0 ? base : kyselySql`${base} + ${offsetMs}`;
  }

  if (offsetMs === 0) {
    return kyselySql`CURRENT_TIMESTAMP`;
  }

  const modifier = formatSecondsModifier(offsetMs);
  return kyselySql`datetime('now', ${modifier})`;
};

export const postgresNowExpression = (offsetMs: number): DbNowExpression => {
  if (offsetMs === 0) {
    return kyselySql`CURRENT_TIMESTAMP`;
  }
  return kyselySql`(CURRENT_TIMESTAMP + (${offsetMs} * interval '1 millisecond'))`;
};

const postgresTransactionNowExpression = (offsetMs: number): DbNowExpression => {
  if (offsetMs === 0) {
    return kyselySql`transaction_timestamp()`;
  }
  return kyselySql`(transaction_timestamp() + (${offsetMs} * interval '1 millisecond'))`;
};

export const mysqlNowExpression = (offsetMs: number): DbNowExpression => {
  if (offsetMs === 0) {
    return kyselySql`CURRENT_TIMESTAMP`;
  }
  const micros = Math.trunc(offsetMs * 1000);
  return kyselySql`TIMESTAMPADD(MICROSECOND, ${micros}, CURRENT_TIMESTAMP)`;
};

export const getDbNowStrategy = (driverConfig: DriverConfig): DbNowStrategy => {
  switch (driverConfig.databaseType) {
    case "sqlite":
      return {
        databaseType: "sqlite",
        expression: sqliteNowExpression,
        preludeStatements: sqliteNowPreludeStatements,
      };
    case "mysql":
      return {
        databaseType: "mysql",
        expression: ({ offsetMs }) => mysqlNowExpression(offsetMs),
      };
    case "postgresql":
      if (driverConfig.driverType === "pglite") {
        return {
          databaseType: "postgresql",
          expression: ({ offsetMs }) => postgresTransactionNowExpression(offsetMs),
        };
      }
      return {
        databaseType: "postgresql",
        expression: ({ offsetMs }) => postgresNowExpression(offsetMs),
      };
    default: {
      const exhaustiveCheck: never = driverConfig.databaseType;
      throw new Error(`Unsupported database type: ${exhaustiveCheck}`);
    }
  }
};
