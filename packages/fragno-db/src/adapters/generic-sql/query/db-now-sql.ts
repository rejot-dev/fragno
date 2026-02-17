import { sql } from "kysely";
import type { AnyColumn } from "../../../schema/create";
import type { DriverConfig } from "../driver-config";
import { sqliteStorageDefault, type SQLiteStorageMode } from "../sqlite-storage";

type ColumnType = AnyColumn["type"];

type BuildDbNowSqlOptions = {
  driverConfig: DriverConfig;
  columnType: ColumnType;
  offsetMs: number;
  sqliteStorageMode?: SQLiteStorageMode;
};

export const buildDbNowSql = ({
  driverConfig,
  columnType,
  offsetMs,
  sqliteStorageMode,
}: BuildDbNowSqlOptions) => {
  if (driverConfig.databaseType === "sqlite") {
    const storageMode = sqliteStorageMode ?? sqliteStorageDefault;
    const storage = columnType === "date" ? storageMode.dateStorage : storageMode.timestampStorage;
    if ((columnType === "timestamp" || columnType === "date") && storage === "epoch-ms") {
      const base = sql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`;
      return offsetMs === 0 ? base : sql`${base} + ${offsetMs}`;
    }
    if (offsetMs === 0) {
      return sql`CURRENT_TIMESTAMP`;
    }
    const roundedSeconds = Math.round((offsetMs / 1000) * 1000) / 1000;
    const modifier = `${roundedSeconds >= 0 ? "+" : ""}${roundedSeconds} seconds`;
    return sql`datetime('now', ${modifier})`;
  }

  if (driverConfig.databaseType === "mysql") {
    if (offsetMs === 0) {
      return sql`CURRENT_TIMESTAMP`;
    }
    const micros = Math.trunc(offsetMs * 1000);
    return sql`TIMESTAMPADD(MICROSECOND, ${micros}, CURRENT_TIMESTAMP)`;
  }

  if (offsetMs === 0) {
    return sql`CURRENT_TIMESTAMP`;
  }
  return sql`(CURRENT_TIMESTAMP + (${offsetMs} * interval '1 millisecond'))`;
};
