import {
  CreateTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import type { SqlNamingStrategy } from "../../../naming/sql-naming";
import type { AnySchema, AnyTable } from "../../../schema/create";
import type {
  ExecuteOptions,
  PreparedMigrations,
} from "../../generic-sql/migration/prepared-migrations";
import { encodeDynamoDBIndexEntry, encodeDynamoDBIndexTuple } from "../dynamodb-index-codec";
import {
  createDynamoDBLayout,
  type DynamoDBLayout,
  type DynamoDBTableLayout,
} from "../dynamodb-layout";

export interface DynamoDBPreparedMigrationsConfig {
  client: DynamoDBDocumentClient;
  schema: AnySchema;
  namespace: string | null;
  tablePrefix?: string;
  namingStrategy?: SqlNamingStrategy;
  updateVersionInMigration?: boolean;
}

export interface DynamoDBCompiledMigration {
  statements: string[];
  fromVersion: number;
  toVersion: number;
}

type DynamoDBSendableClient = {
  send(command: object): Promise<unknown>;
};

const SETTINGS_KEY = "schema_version";

export function createDynamoDBPreparedMigrations(
  config: DynamoDBPreparedMigrationsConfig,
): PreparedMigrations & {
  getSchemaVersion(namespace: string): Promise<string | undefined>;
  isConnectionHealthy(): Promise<boolean>;
} {
  const layout = createDynamoDBLayout(config);
  const client = config.client as unknown as DynamoDBSendableClient;
  const defaultUpdateVersion = config.updateVersionInMigration ?? true;

  const compile = (fromVersion: number, toVersion: number): DynamoDBCompiledMigration => {
    validateVersions(config.schema, fromVersion, toVersion);
    return {
      fromVersion,
      toVersion,
      statements: [
        `ensure table ${layout.settingsTableName}`,
        ...layout
          .getAllTableLayouts()
          .flatMap((tableLayout) => [
            `ensure table ${tableLayout.baseTableName}`,
            `ensure table ${tableLayout.indexTableName}`,
          ]),
        `write schema version ${layout.namespace}=${toVersion}`,
      ],
    };
  };

  const execute = async (fromVersion: number, toVersion?: number, options?: ExecuteOptions) => {
    const targetVersion = toVersion ?? config.schema.version;
    validateVersions(config.schema, fromVersion, targetVersion);

    await ensureSettingsTable(client, layout.settingsTableName);
    const tableLayouts = layout.getAllTableLayouts();
    const tableResults = await Promise.all(
      tableLayouts.flatMap((tableLayout) => [
        ensureBaseTable(client, tableLayout.baseTableName).then((created) => ({
          created,
          kind: "base" as const,
          tableName: tableLayout.baseTableName,
        })),
        ensureIndexTable(client, tableLayout.indexTableName).then((created) => ({
          created,
          kind: "index" as const,
          tableName: tableLayout.indexTableName,
        })),
      ]),
    );
    const newlyCreatedBaseTables = new Set(
      tableResults
        .filter((result) => result.kind === "base" && result.created)
        .map((result) => result.tableName),
    );

    await backfillIndexes(client, config.schema, layout, newlyCreatedBaseTables);

    const updateVersion = options?.updateVersionInMigration ?? defaultUpdateVersion;
    if (updateVersion && targetVersion !== fromVersion) {
      await writeSchemaVersion(client, layout, String(targetVersion));
    }
  };

  return {
    async execute(fromVersion, toVersion, options) {
      await execute(fromVersion, toVersion, options);
    },
    async executeWithDriver(_driver, fromVersion, toVersion, options) {
      await execute(fromVersion, toVersion, options);
    },
    getSQL(fromVersion, toVersion) {
      const targetVersion = toVersion ?? config.schema.version;
      return compile(fromVersion, targetVersion).statements.join("\n");
    },
    compile(fromVersion, toVersion) {
      const targetVersion = toVersion ?? config.schema.version;
      return compile(fromVersion, targetVersion) as never;
    },
    async getSchemaVersion(namespace) {
      return getSchemaVersion(client, layout.settingsTableName, namespace);
    },
    async isConnectionHealthy() {
      await client.send(new ListTablesCommand({ Limit: 1 }));
      return true;
    },
  };
}

async function ensureSettingsTable(
  client: DynamoDBSendableClient,
  tableName: string,
): Promise<boolean> {
  return ensureTable(
    client,
    tableName,
    [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
  );
}

async function ensureBaseTable(
  client: DynamoDBSendableClient,
  tableName: string,
): Promise<boolean> {
  return ensureTable(
    client,
    tableName,
    [{ AttributeName: "pk", AttributeType: "S" }],
    [{ AttributeName: "pk", KeyType: "HASH" }],
  );
}

async function ensureIndexTable(
  client: DynamoDBSendableClient,
  tableName: string,
): Promise<boolean> {
  return ensureTable(
    client,
    tableName,
    [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
  );
}

async function ensureTable(
  client: DynamoDBSendableClient,
  tableName: string,
  attributeDefinitions: { AttributeName: string; AttributeType: "S" }[],
  keySchema: { AttributeName: string; KeyType: "HASH" | "RANGE" }[],
): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return false;
  } catch (error) {
    if (!isResourceNotFound(error)) {
      throw error;
    }
  }

  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: attributeDefinitions,
      KeySchema: keySchema,
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  return true;
}

async function backfillIndexes(
  client: DynamoDBSendableClient,
  schema: AnySchema,
  layout: DynamoDBLayout,
  newlyCreatedBaseTables: ReadonlySet<string>,
): Promise<void> {
  for (const table of Object.values(schema.tables)) {
    const tableLayout = layout.getTableLayout(table);
    if (newlyCreatedBaseTables.has(tableLayout.baseTableName)) {
      continue;
    }
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const result = (await client.send(
        new ScanCommand({
          TableName: tableLayout.baseTableName,
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };

      for (const row of result.Items ?? []) {
        await backfillRowIndexes(client, table, tableLayout, row);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
  }
}

async function backfillRowIndexes(
  client: DynamoDBSendableClient,
  table: AnyTable,
  tableLayout: DynamoDBTableLayout,
  row: Record<string, unknown>,
): Promise<void> {
  const externalId = row["id"];
  const internalId = row["_internalId"];
  if (typeof externalId !== "string" || typeof internalId !== "string") {
    return;
  }

  const primaryEntry = {
    pk: "idx#_primary",
    sk: encodeDynamoDBIndexEntry([{ column: table.getIdColumn(), value: externalId }], externalId),
    externalId,
    internalId,
  };
  const items = [
    primaryEntry,
    ...Object.values(table.indexes).flatMap((index) => {
      const segments = index.columns.map((column) => ({ column, value: row[column.name] }));
      const hasNullSegment = segments.some(
        (segment) => segment.value === null || segment.value === undefined,
      );
      const entry = {
        pk: `idx#${index.name}`,
        sk: encodeDynamoDBIndexEntry(segments, externalId),
        externalId,
        internalId,
      };
      if (!index.unique || hasNullSegment) {
        return [entry];
      }
      return [
        entry,
        {
          pk: `unique#${index.name}`,
          sk: encodeDynamoDBIndexTuple(segments, { mode: "equality" }),
          externalId,
          internalId,
        },
      ];
    }),
  ];

  for (const item of items) {
    await client.send(new PutCommand({ TableName: tableLayout.indexTableName, Item: item }));
  }
}

async function writeSchemaVersion(
  client: DynamoDBSendableClient,
  layout: DynamoDBLayout,
  version: string,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: layout.settingsTableName,
      Item: {
        pk: SETTINGS_KEY,
        sk: toDynamoDBSettingsNamespace(layout.namespace),
        value: version,
      },
    }),
  );
}

function toDynamoDBSettingsNamespace(namespace: string): string {
  return namespace === "" ? "empty" : namespace;
}

async function getSchemaVersion(
  client: DynamoDBSendableClient,
  settingsTableName: string,
  namespace: string,
): Promise<string | undefined> {
  try {
    const result = (await client.send(
      new GetCommand({
        TableName: settingsTableName,
        Key: { pk: SETTINGS_KEY, sk: toDynamoDBSettingsNamespace(namespace) },
        ConsistentRead: true,
      }),
    )) as { Item?: { value?: unknown } };
    const value = result.Item?.value;
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error(`Schema version for namespace ${namespace} is not a string.`);
    }
    return value;
  } catch (error) {
    if (isResourceNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function validateVersions(schema: AnySchema, fromVersion: number, toVersion: number): void {
  if (fromVersion < 0) {
    throw new Error(`fromVersion cannot be negative: ${fromVersion}`);
  }
  if (toVersion < 0) {
    throw new Error(`toVersion cannot be negative: ${toVersion}`);
  }
  if (toVersion < fromVersion) {
    throw new Error(
      `Cannot migrate backwards: fromVersion (${fromVersion}) > toVersion (${toVersion})`,
    );
  }
  if (toVersion > schema.version) {
    throw new Error(`toVersion (${toVersion}) exceeds schema version (${schema.version})`);
  }
}

function isResourceNotFound(error: unknown): boolean {
  return (
    error instanceof ResourceNotFoundException ||
    (error instanceof Error && error.name === "ResourceNotFoundException")
  );
}
