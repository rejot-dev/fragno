import { createSQLSerializer } from "../../query/serialize/create-sql-serializer";
import type { AnyColumn } from "../../schema/create";
import { SQLocalDriverConfig } from "../generic-sql/driver-config";

const sqliteSerializer = createSQLSerializer(new SQLocalDriverConfig());

export const snapshotInMemoryColumnValue = (value: unknown, column: AnyColumn): unknown => {
  if (
    value === undefined ||
    (column.type !== "json" &&
      column.type !== "binary" &&
      column.type !== "date" &&
      column.type !== "timestamp")
  ) {
    return value;
  }

  return sqliteSerializer.deserialize(sqliteSerializer.serialize(value, column), column);
};
