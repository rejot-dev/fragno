import { describe, expect, it } from "vitest";

import { column, idColumn, schema } from "../../schema/create";
import {
  decodeDynamoDBIndexEntry,
  decodeDynamoDBIndexTuple,
  encodeDynamoDBIndexEntry,
  encodeDynamoDBIndexTuple,
} from "./dynamodb-index-codec";
import { createDynamoDBLayout } from "./dynamodb-layout";
import {
  decodeDynamoDBValue,
  encodeDynamoDBValue,
  estimateDynamoDBItemSizeBytes,
} from "./dynamodb-value-codec";

const testSchema = schema("shop", (s) =>
  s.addTable("orders", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .addColumn("score", column("integer"))
      .addColumn("price", column("decimal"))
      .addColumn("accountId", column("bigint"))
      .addColumn("active", column("bool"))
      .addColumn("payload", column("json").nullable())
      .addColumn("data", column("binary"))
      .addColumn("birthday", column("date"))
      .addColumn("createdAt", column("timestamp"))
      .createIndex("byScore", ["score"]),
  ),
);

const table = testSchema.tables.orders;
const columns = table.columns;

describe("DynamoDB layout", () => {
  it("resolves settings, base, and index table names", () => {
    const layout = createDynamoDBLayout({
      schema: testSchema,
      namespace: "shop",
      tablePrefix: "fragno",
    });

    expect(layout.settingsTableName).toBe("fragno__settings");
    expect(layout.getTableLayout(table)).toEqual({
      logicalTableName: "orders",
      baseTableName: "fragno__shop__orders",
      indexTableName: "fragno__shop__orders__idx",
    });
  });
});

describe("DynamoDB value codec", () => {
  it("round-trips supported scalar values", () => {
    const timestamp = new Date("2025-01-02T03:04:05.006Z");
    const binary = new Uint8Array([1, 2, 3]);
    const cases = [
      [columns.name, "Ada"],
      [columns.score, 42],
      [columns.price, 12.5],
      [columns.accountId, 1234567890123456789n],
      [columns.active, true],
      [columns.payload, { nested: ["x", 1, false, null] }],
      [columns.data, binary],
      [columns.birthday, timestamp],
      [columns.createdAt, timestamp],
      [columns.payload, null],
    ] as const;

    for (const [testColumn, value] of cases) {
      expect(decodeDynamoDBValue(encodeDynamoDBValue(value, testColumn), testColumn)).toEqual(
        value,
      );
    }
  });

  it("estimates item sizes", () => {
    expect(estimateDynamoDBItemSizeBytes({ pk: "a", value: "hello" })).toBeGreaterThan(0);
  });
});

describe("DynamoDB index codec", () => {
  it("orders scalar tuple values lexicographically in Fragno order", () => {
    const numberKeys = [-10, -1, 0, 1, 9, 10].map((value) =>
      encodeDynamoDBIndexTuple([{ column: columns.score, value }]),
    );
    expect([...numberKeys].sort()).toEqual(numberKeys);

    const bigintKeys = [-10n, -1n, 0n, 1n, 9n, 10n].map((value) =>
      encodeDynamoDBIndexTuple([{ column: columns.accountId, value }]),
    );
    expect([...bigintKeys].sort()).toEqual(bigintKeys);

    const stringKeys = [null, "", "a", "aa", "b"].map((value) =>
      encodeDynamoDBIndexTuple([{ column: columns.name, value }]),
    );
    expect([...stringKeys].sort()).toEqual(stringKeys);

    const boolKeys = [null, false, true].map((value) =>
      encodeDynamoDBIndexTuple([{ column: columns.active, value }]),
    );
    expect([...boolKeys].sort()).toEqual(boolKeys);

    const timestampKeys = [
      null,
      new Date("2024-01-01T00:00:00.000Z"),
      new Date("2025-01-01T00:00:00.000Z"),
    ].map((value) => encodeDynamoDBIndexTuple([{ column: columns.createdAt, value }]));
    expect([...timestampKeys].sort()).toEqual(timestampKeys);
  });

  it("orders equal non-unique index values by external ID tiebreaker", () => {
    const entries = ["a", "b", "c"].map((externalId) =>
      encodeDynamoDBIndexEntry([{ column: columns.score, value: 7 }], externalId),
    );

    expect([...entries].sort()).toEqual(entries);
    expect(decodeDynamoDBIndexEntry(entries[0]!)).toEqual({ values: [7], externalId: "a" });
  });

  it("decodes tuples", () => {
    const encoded = encodeDynamoDBIndexTuple([
      { column: columns.name, value: "Ada" },
      { column: columns.accountId, value: 123n },
      { column: columns.createdAt, value: new Date("2024-01-01T00:00:00.000Z") },
    ]);

    expect(decodeDynamoDBIndexTuple(encoded)).toEqual([
      "Ada",
      123n,
      new Date("2024-01-01T00:00:00.000Z"),
    ]);
  });

  it("rejects JSON and binary values for range ordering", () => {
    expect(() => encodeDynamoDBIndexTuple([{ column: columns.payload, value: { a: 1 } }])).toThrow(
      /JSON column/,
    );
    expect(() =>
      encodeDynamoDBIndexTuple([{ column: columns.data, value: new Uint8Array([1]) }]),
    ).toThrow(/Binary column/);
  });
});
