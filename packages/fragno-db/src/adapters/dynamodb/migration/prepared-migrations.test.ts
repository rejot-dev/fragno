import { expect, it } from "vitest";

import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { DatabaseConstraintError } from "../../../errors";
import { column, idColumn, schema } from "../../../schema/create";
import { DynamoDBAdapter } from "../dynamodb-adapter";
import { createDynamoDBLayout } from "../dynamodb-layout";
import { describeDynamoDBLocal, getDynamoDBLocalTestContext } from "../test-utils";

const migrationBaseSchema = schema("shop", (s) =>
  s.addTable("orders", (t) => t.addColumn("id", idColumn()).addColumn("status", column("string"))),
);

const migrationSchema = schema("shop", (s) =>
  s
    .addTable("orders", (t) => t.addColumn("id", idColumn()).addColumn("status", column("string")))
    .alterTable("orders", (t) => t.createIndex("byStatus", ["status"])),
);

const uniqueMigrationSchema = schema("shop", (s) =>
  s
    .addTable("orders", (t) => t.addColumn("id", idColumn()).addColumn("status", column("string")))
    .alterTable("orders", (t) => t.createIndex("uniqueStatus", ["status"], { unique: true })),
);

describeDynamoDBLocal("DynamoDB migrations", () => {
  it("creates settings, base, and index tables idempotently and stores schema version", async () => {
    const context = getDynamoDBLocalTestContext();
    expect(context).not.toBeNull();
    const { client, tablePrefix } = context!;
    const adapter = new DynamoDBAdapter({ client, tablePrefix });
    const layout = createDynamoDBLayout({
      schema: migrationSchema,
      namespace: "shop",
      tablePrefix,
    });

    await expect(adapter.getSchemaVersion("shop")).resolves.toBeUndefined();

    const migrations = adapter.prepareMigrations(migrationSchema, "shop");
    await migrations.execute(0);
    await migrations.execute(0, migrationSchema.version);

    await expect(adapter.getSchemaVersion("shop")).resolves.toBe(String(migrationSchema.version));
    await expect(adapter.isConnectionHealthy()).resolves.toBe(true);

    const tables = await listAllTableNames(client);
    expect(tables).toEqual(
      expect.arrayContaining([
        layout.settingsTableName,
        layout.getTableLayout("orders").baseTableName,
        layout.getTableLayout("orders").indexTableName,
      ]),
    );
  });

  it("fails unique index backfill when existing rows contain duplicates", async () => {
    const context = getDynamoDBLocalTestContext();
    expect(context).not.toBeNull();
    const { client, tablePrefix } = context!;
    const baseAdapter = new DynamoDBAdapter({ client, tablePrefix });
    await baseAdapter.prepareMigrations(migrationBaseSchema, "shop").execute(0);

    const layout = createDynamoDBLayout({
      schema: migrationBaseSchema,
      namespace: "shop",
      tablePrefix,
    });
    const tableLayout = layout.getTableLayout("orders");
    await client.send(
      new PutCommand({
        TableName: tableLayout.baseTableName,
        Item: {
          pk: "order_duplicate_status_1",
          id: "order_duplicate_status_1",
          status: "duplicate",
          _internalId: "1",
          _version: 0,
        },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: tableLayout.baseTableName,
        Item: {
          pk: "order_duplicate_status_2",
          id: "order_duplicate_status_2",
          status: "duplicate",
          _internalId: "2",
          _version: 0,
        },
      }),
    );

    const uniqueAdapter = new DynamoDBAdapter({ client, tablePrefix });
    await expect(
      uniqueAdapter.prepareMigrations(uniqueMigrationSchema, "shop").execute(1, 2),
    ).rejects.toBeInstanceOf(DatabaseConstraintError);
  });

  it("backfills added index entries during migration", async () => {
    const context = getDynamoDBLocalTestContext();
    expect(context).not.toBeNull();
    const { client, tablePrefix } = context!;
    const baseAdapter = new DynamoDBAdapter({ client, tablePrefix });
    await baseAdapter.prepareMigrations(migrationBaseSchema, "shop").execute(0);

    const layout = createDynamoDBLayout({
      schema: migrationSchema,
      namespace: "shop",
      tablePrefix,
    });
    const tableLayout = layout.getTableLayout("orders");
    await client.send(
      new PutCommand({
        TableName: tableLayout.baseTableName,
        Item: {
          pk: "order_backfill",
          id: "order_backfill",
          status: "open",
          _internalId: "1",
          _version: 0,
        },
      }),
    );

    const indexedAdapter = new DynamoDBAdapter({ client, tablePrefix });
    await indexedAdapter.prepareMigrations(migrationSchema, "shop").execute(1, 2);

    const result = await client.send(
      new QueryCommand({
        TableName: tableLayout.indexTableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": "idx#byStatus" },
      }),
    );

    expect(result.Items).toEqual([
      expect.objectContaining({ externalId: "order_backfill", internalId: "1" }),
    ]);
  });
});

async function listAllTableNames(client: {
  send(command: object): Promise<unknown>;
}): Promise<string[]> {
  const tables: string[] = [];
  let exclusiveStartTableName: string | undefined;
  do {
    const result = (await client.send(
      new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName }),
    )) as { TableNames?: string[]; LastEvaluatedTableName?: string };
    tables.push(...(result.TableNames ?? []));
    exclusiveStartTableName = result.LastEvaluatedTableName;
  } while (exclusiveStartTableName);
  return tables;
}
