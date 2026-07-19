import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { internalSchema } from "../../fragments/internal-fragment.schema";
import type { AnySchema } from "../../schema/create";
import {
  queryEngineSuiteSchema,
  queryEngineSuiteSecondarySchema,
} from "../test-suite/query-engine-schema";
import { describeQueryEngineSuite } from "../test-suite/query-engine-suite";
import { DynamoDBAdapter } from "./dynamodb-adapter";
import { createDynamoDBLayout } from "./dynamodb-layout";
import { describeDynamoDBLocal, getDynamoDBLocalTestContext } from "./test-utils";

const namespace = "query_engine_suite";
const secondaryNamespace = "query_engine_suite_secondary";

describeDynamoDBLocal("query engine contract: dynamodb", () => {
  describeQueryEngineSuite({
    name: "dynamodb",
    reuseContext: true,
    createAdapter: async () => {
      const context = getDynamoDBLocalTestContext();
      if (!context) {
        throw new Error("FRAGNO_DYNAMODB_ENDPOINT is required for DynamoDB query-engine suite.");
      }

      const adapter = new DynamoDBAdapter({
        client: context.client,
        tablePrefix: context.tablePrefix,
        allowScans: true,
      });
      return { adapter, close: () => adapter.close() };
    },
    resetContext: async ({ adapter }) => {
      if (adapter instanceof DynamoDBAdapter) {
        await clearDynamoDBSuiteTables(adapter);
      }
    },
    capabilities: {
      constraints: false,
      databaseDefaultTimestamp: false,
    },
  });
});

async function clearDynamoDBSuiteTables(adapter: DynamoDBAdapter): Promise<void> {
  const tableNames = [
    ...getDynamoDBDataTableNames(adapter, internalSchema, ""),
    ...getDynamoDBDataTableNames(adapter, queryEngineSuiteSchema, namespace),
    ...getDynamoDBDataTableNames(adapter, queryEngineSuiteSecondarySchema, secondaryNamespace),
  ];
  await Promise.all(tableNames.map((tableName) => clearDynamoDBTable(adapter, tableName)));
}

function getDynamoDBDataTableNames(
  adapter: DynamoDBAdapter,
  schema: AnySchema,
  namespace: string,
): string[] {
  const layout = createDynamoDBLayout({
    schema,
    namespace,
    tablePrefix: adapter.tablePrefix,
    namingStrategy: adapter.namingStrategy,
  });
  return layout
    .getAllTableLayouts()
    .flatMap((tableLayout) => [tableLayout.baseTableName, tableLayout.indexTableName]);
}

async function clearDynamoDBTable(adapter: DynamoDBAdapter, tableName: string): Promise<void> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = (await adapter.client.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "#pk, #sk",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };

    const items = result.Items ?? [];
    for (let index = 0; index < items.length; index += 25) {
      const batch = items.slice(index, index + 25);
      if (batch.length === 0) {
        continue;
      }
      await deleteDynamoDBBatch(
        adapter,
        tableName,
        batch.map((item) => getDynamoDBKey(item)),
      );
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
}

async function deleteDynamoDBBatch(
  adapter: DynamoDBAdapter,
  tableName: string,
  keys: Record<string, unknown>[],
): Promise<void> {
  let pending = keys;
  while (pending.length > 0) {
    const result = (await adapter.client.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: pending.map((key) => ({ DeleteRequest: { Key: key } })),
        },
      }),
    )) as {
      UnprocessedItems?: Record<string, { DeleteRequest: { Key: Record<string, unknown> } }[]>;
    };

    pending = (result.UnprocessedItems?.[tableName] ?? []).map((item) => item.DeleteRequest.Key);
  }
}

function getDynamoDBKey(item: Record<string, unknown>): Record<string, unknown> {
  if (item["sk"] !== undefined) {
    return { pk: item["pk"], sk: item["sk"] };
  }
  return { pk: item["pk"] };
}
