import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { buildIndexKey } from "./store";

const testSchema = schema("test", (s) =>
  s.addTable("events", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("createdAt", column("timestamp"))
      .addColumn("isActive", column("bool"))
      .addColumn("payload", column("json"))
      .addColumn("size", column("bigint"))
      .addColumn("userId", referenceColumn())
      .createIndex("compound_idx", ["createdAt", "isActive", "payload", "size", "userId"]),
  ),
);

describe("in-memory index normalization", () => {
  it("normalizes index keys using SQLite serializer semantics", () => {
    const table = testSchema.tables.events;
    const index = table.indexes["compound_idx"];
    if (!index) {
      throw new Error("compound_idx missing from schema");
    }

    const createdAt = new Date("2024-01-01T00:00:00.000Z");
    const payload = { ok: true, count: 2 };
    const size = 9n;
    const userId = 12n;

    const row = {
      id: "evt_1",
      createdAt,
      isActive: true,
      payload,
      size,
      userId,
    };

    const key = buildIndexKey(
      table,
      { name: index.name, columnNames: [...index.columnNames], unique: index.unique },
      row,
    );

    const expectedBigint = Buffer.alloc(8);
    expectedBigint.writeBigInt64BE(size);

    expect(key).toEqual([
      createdAt.getTime(),
      1,
      JSON.stringify(payload),
      expectedBigint,
      Number(userId),
    ]);
  });
});
