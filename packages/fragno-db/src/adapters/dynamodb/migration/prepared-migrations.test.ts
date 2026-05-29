import { expect, it } from "vitest";

import { ListTablesCommand } from "@aws-sdk/client-dynamodb";

import { column, idColumn, schema } from "../../../schema/create";
import { DynamoDBAdapter } from "../dynamodb-adapter";
import { createDynamoDBLayout } from "../dynamodb-layout";
import { describeDynamoDBLocal, getDynamoDBLocalTestContext } from "../test-utils";

const migrationSchema = schema("shop", (s) =>
  s.addTable("orders", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("status", column("string"))
      .createIndex("byStatus", ["status"]),
  ),
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

    const tables = (await client.send(new ListTablesCommand({}))).TableNames ?? [];
    expect(tables).toEqual(
      expect.arrayContaining([
        layout.settingsTableName,
        layout.getTableLayout("orders").baseTableName,
        layout.getTableLayout("orders").indexTableName,
      ]),
    );
  });
});
