import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { Condition, Operator } from "../../query/condition-builder";
import type {
  CompiledMutation,
  MutationResult,
  UOWExecutor,
} from "../../query/unit-of-work/unit-of-work";
import { resolveFragnoIdValue } from "../../query/value-encoding";
import type { AnyColumn, AnyTable } from "../../schema/create";
import { FragnoId, FragnoReference } from "../../schema/create";
import { decodeDynamoDBIndexEntry, encodeDynamoDBIndexEntry } from "./dynamodb-index-codec";
import type { DynamoDBRawResult, DynamoDBRawRow } from "./dynamodb-uow-decoder";
import type {
  DynamoDBCommandPlan,
  DynamoDBCreatePlan,
  DynamoDBFindPlan,
} from "./dynamodb-uow-operation-compiler";
import { assertDynamoDBItemSize, type BaseRowItem } from "./dynamodb-value-codec";

export interface DynamoDBUOWExecutorOptions {
  client: DynamoDBDocumentClient;
  settingsTableName: string;
  consistentRead?: boolean;
  maxFilteredReadPages?: number;
  allowScans?: boolean;
}

type DynamoDBSendableClient = {
  send(command: object): Promise<unknown>;
};

type CreateReservation = {
  plan: DynamoDBCreatePlan;
  internalId: bigint;
};

const INTERNAL_ID_COUNTER_PK = "internal_id_counter";
const PRIMARY_INDEX_NAME = "_primary";
const DYNAMODB_TRANSACTION_ACTION_LIMIT = 100;

export class DynamoDBUOWExecutor implements UOWExecutor<DynamoDBCommandPlan, DynamoDBRawResult> {
  readonly #client: DynamoDBSendableClient;
  readonly #settingsTableName: string;
  readonly #consistentRead: boolean;
  readonly #maxFilteredReadPages: number;
  readonly #allowScans: boolean;

  constructor(options: DynamoDBUOWExecutorOptions) {
    this.#client = options.client as unknown as DynamoDBSendableClient;
    this.#settingsTableName = options.settingsTableName;
    this.#consistentRead = options.consistentRead ?? true;
    this.#maxFilteredReadPages = options.maxFilteredReadPages ?? 10;
    this.#allowScans = options.allowScans ?? false;
  }

  async executeRetrievalPhase(retrievalBatch: DynamoDBCommandPlan[]): Promise<DynamoDBRawResult[]> {
    const results: DynamoDBRawResult[] = [];

    for (const plan of retrievalBatch) {
      if (plan.kind === "find") {
        results.push(await this.#executeFind(plan));
        continue;
      }

      if (plan.kind === "count") {
        throw new Error("DynamoDB count execution is not implemented until slice 6.");
      }

      throw new Error(`Unsupported DynamoDB retrieval plan: ${plan.kind}`);
    }

    return results;
  }

  async executeMutationPhase(
    mutationBatch: CompiledMutation<DynamoDBCommandPlan>[],
  ): Promise<MutationResult> {
    if (mutationBatch.length === 0) {
      return { success: true, createdInternalIds: [] };
    }

    const unsupported = mutationBatch.find((mutation) => mutation.query.kind !== "create");
    if (unsupported) {
      throw new Error(
        `DynamoDB ${unsupported.query.kind} mutation execution is not implemented until slice 5.`,
      );
    }

    const createPlans = mutationBatch.map((mutation) => mutation.query as DynamoDBCreatePlan);
    const reservations = await this.#reserveInternalIds(createPlans);
    const transactItems = reservations.flatMap((reservation) =>
      this.#createTransactItems(reservation.plan, reservation.internalId),
    );

    if (transactItems.length > DYNAMODB_TRANSACTION_ACTION_LIMIT) {
      throw new Error(
        `DynamoDB transaction has ${transactItems.length} actions; maximum is ${DYNAMODB_TRANSACTION_ACTION_LIMIT}.`,
      );
    }

    await this.#client.send(new TransactWriteCommand({ TransactItems: transactItems }));

    return {
      success: true,
      createdInternalIds: reservations.map((reservation) => reservation.internalId),
    };
  }

  async #executeFind(plan: DynamoDBFindPlan): Promise<DynamoDBRawRow[]> {
    if (plan.indexName !== PRIMARY_INDEX_NAME) {
      throw new Error(
        `DynamoDB secondary index find is not implemented until slice 6: ${plan.tableName}.${plan.indexName}`,
      );
    }
    if (plan.after || plan.before || plan.withCursor) {
      throw new Error("DynamoDB cursor pagination is not implemented until slice 6.");
    }

    const matchedRows: DynamoDBRawRow[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    let pagesRead = 0;

    do {
      pagesRead += 1;
      if (pagesRead > this.#maxFilteredReadPages) {
        throw new Error(
          `DynamoDB read limit exceeded for ${plan.tableName}.${plan.indexName}; increase maxFilteredReadPages to read more filtered pages.`,
        );
      }

      const queryResult = (await this.#client.send(
        new QueryCommand({
          TableName: plan.layout.indexTableName,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": `idx#${plan.indexName}` },
          ConsistentRead: this.#consistentRead,
          ScanIndexForward: plan.orderDirection !== "desc",
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      )) as { Items?: DynamoDBIndexEntryItem[]; LastEvaluatedKey?: Record<string, unknown> };

      const entries = queryResult.Items ?? [];
      const rows = await this.#batchGetRows(
        plan,
        entries.map((entry) => entry.externalId),
      );
      for (const row of rows) {
        if (plan.condition && !evaluateDynamoDBCondition(plan.condition, plan.table, row)) {
          continue;
        }
        matchedRows.push(selectDynamoDBRow(row, plan.table, plan.selectedColumns));
        if (plan.pageSize !== undefined && matchedRows.length >= plan.pageSize) {
          return matchedRows;
        }
      }

      lastEvaluatedKey = queryResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (!this.#allowScans && matchedRows.length === 0 && plan.condition === undefined) {
      return matchedRows;
    }

    return matchedRows;
  }

  async #batchGetRows(
    plan: DynamoDBFindPlan,
    externalIds: readonly string[],
  ): Promise<DynamoDBRawRow[]> {
    if (externalIds.length === 0) {
      return [];
    }

    const orderedRows = new Map<string, DynamoDBRawRow>();
    for (let offset = 0; offset < externalIds.length; offset += 100) {
      const chunk = externalIds.slice(offset, offset + 100);
      const result = (await this.#client.send(
        new BatchGetCommand({
          RequestItems: {
            [plan.layout.baseTableName]: {
              Keys: chunk.map((externalId) => ({ pk: externalId })),
              ConsistentRead: this.#consistentRead,
            },
          },
        }),
      )) as { Responses?: Record<string, DynamoDBRawRow[]> };

      for (const row of result.Responses?.[plan.layout.baseTableName] ?? []) {
        if (typeof row["pk"] === "string") {
          orderedRows.set(row["pk"], row);
        }
      }
    }

    return externalIds.flatMap((externalId) => {
      const row = orderedRows.get(externalId);
      return row ? [row] : [];
    });
  }

  async #reserveInternalIds(plans: readonly DynamoDBCreatePlan[]): Promise<CreateReservation[]> {
    const byBaseTable = new Map<string, DynamoDBCreatePlan[]>();
    for (const plan of plans) {
      const group = byBaseTable.get(plan.layout.baseTableName) ?? [];
      group.push(plan);
      byBaseTable.set(plan.layout.baseTableName, group);
    }

    const reservationByPlan = new Map<DynamoDBCreatePlan, bigint>();
    for (const [baseTableName, group] of byBaseTable) {
      const firstInternalId = await this.#reserveInternalIdBlock(baseTableName, group.length);
      group.forEach((plan, index) => reservationByPlan.set(plan, firstInternalId + BigInt(index)));
    }

    return plans.map((plan) => {
      const internalId = reservationByPlan.get(plan);
      if (internalId === undefined) {
        throw new Error(`Failed to reserve DynamoDB internal ID for ${plan.tableName}.`);
      }
      return { plan, internalId };
    });
  }

  async #reserveInternalIdBlock(baseTableName: string, count: number): Promise<bigint> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const currentValue = await this.#readInternalIdCounter(baseTableName);
      const current = currentValue === undefined ? 0n : BigInt(currentValue);
      const next = current + BigInt(count);

      try {
        await this.#client.send(
          new UpdateCommand({
            TableName: this.#settingsTableName,
            Key: { pk: INTERNAL_ID_COUNTER_PK, sk: baseTableName },
            UpdateExpression: "SET #value = :next",
            ConditionExpression:
              currentValue === undefined ? "attribute_not_exists(#pk)" : "#value = :current",
            ExpressionAttributeNames: { "#pk": "pk", "#value": "value" },
            ExpressionAttributeValues:
              currentValue === undefined
                ? { ":next": next.toString() }
                : { ":next": next.toString(), ":current": currentValue },
          }),
        );
        return current + 1n;
      } catch (error) {
        if (!isConditionalCheckFailed(error)) {
          throw error;
        }
      }
    }

    throw new Error(`Failed to reserve DynamoDB internal IDs for ${baseTableName}.`);
  }

  async #readInternalIdCounter(baseTableName: string): Promise<string | undefined> {
    const result = (await this.#client.send(
      new GetCommand({
        TableName: this.#settingsTableName,
        Key: { pk: INTERNAL_ID_COUNTER_PK, sk: baseTableName },
        ConsistentRead: true,
      }),
    )) as { Item?: { value?: unknown } };

    const value = result.Item?.value;
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error(`DynamoDB internal ID counter for ${baseTableName} is not a string.`);
    }
    return value;
  }

  #createTransactItems(plan: DynamoDBCreatePlan, internalId: bigint): object[] {
    const baseRow: BaseRowItem = {
      pk: plan.externalId,
      ...plan.item,
      id: plan.externalId,
      _internalId: internalId.toString(),
      _version: 0,
    };
    const primaryIndexEntry = createPrimaryIndexEntry(plan, internalId);

    assertDynamoDBItemSize(baseRow);
    assertDynamoDBItemSize(primaryIndexEntry);

    return [
      {
        Put: {
          TableName: plan.layout.baseTableName,
          Item: baseRow,
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      },
      {
        Put: {
          TableName: plan.layout.indexTableName,
          Item: primaryIndexEntry,
          ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        },
      },
    ];
  }
}

interface DynamoDBIndexEntryItem {
  pk: string;
  sk: string;
  externalId: string;
  internalId: string;
}

function createPrimaryIndexEntry(
  plan: DynamoDBCreatePlan,
  internalId: bigint,
): DynamoDBIndexEntryItem {
  const idColumn = plan.table.getIdColumn();
  const sk = encodeDynamoDBIndexEntry(
    [{ column: idColumn, value: plan.externalId }],
    plan.externalId,
  );
  return {
    pk: `idx#${PRIMARY_INDEX_NAME}`,
    sk,
    externalId: decodeDynamoDBIndexEntry(sk).externalId,
    internalId: internalId.toString(),
  };
}

function selectDynamoDBRow(
  row: DynamoDBRawRow,
  table: AnyTable,
  selectedColumns: true | readonly string[],
): DynamoDBRawRow {
  const selection = new Set<string>();
  if (selectedColumns === true) {
    for (const columnName of Object.keys(table.columns)) {
      selection.add(columnName);
    }
  } else {
    for (const columnName of selectedColumns) {
      selection.add(columnName);
    }
  }
  selection.add("_internalId");
  selection.add("_version");

  const selected: DynamoDBRawRow = {};
  for (const columnName of selection) {
    if (Object.prototype.hasOwnProperty.call(row, columnName)) {
      selected[columnName] = row[columnName];
    }
  }
  return selected;
}

function evaluateDynamoDBCondition(
  condition: Condition,
  table: AnyTable,
  row: DynamoDBRawRow,
): boolean {
  switch (condition.type) {
    case "and":
      return condition.items.every((item) => evaluateDynamoDBCondition(item, table, row));
    case "or":
      return condition.items.some((item) => evaluateDynamoDBCondition(item, table, row));
    case "not":
      return !evaluateDynamoDBCondition(condition.item, table, row);
    case "compare":
      return evaluateComparison(condition, table, row);
  }
}

function evaluateComparison(
  condition: Extract<Condition, { type: "compare" }>,
  _table: AnyTable,
  row: DynamoDBRawRow,
): boolean {
  const column = condition.a;
  const left = normalizeComparableValue(row[column.name], column);
  const operator = condition.operator;

  if (operator === "in" || operator === "not in") {
    const values = Array.isArray(condition.b) ? condition.b : [];
    const matches = values.some(
      (value) => compareValues(left, normalizeInputComparableValue(value, column)) === 0,
    );
    return operator === "in" ? matches : !matches;
  }

  const right = normalizeInputComparableValue(condition.b, column);
  const comparison = compareValues(left, right);

  switch (operator) {
    case "=":
    case "is":
      return comparison === 0;
    case "!=":
    case "is not":
      return comparison !== 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case "contains":
    case "not contains":
    case "starts with":
    case "not starts with":
    case "ends with":
    case "not ends with":
      return evaluateStringComparison(String(left ?? ""), operator, String(right ?? ""));
  }
}

function normalizeComparableValue(value: unknown, column: AnyColumn): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (column.role === "internal-id" || column.role === "reference" || column.type === "bigint") {
    return BigInt(String(value));
  }
  if (column.type === "date" || column.type === "timestamp") {
    return new Date(String(value)).getTime();
  }
  return value;
}

function normalizeInputComparableValue(value: unknown, column: AnyColumn): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  const resolved = resolveFragnoIdValue(resolveReferenceValue(value), column);
  if (resolved === undefined || resolved === null) {
    return null;
  }
  if (column.role === "internal-id" || column.role === "reference" || column.type === "bigint") {
    return BigInt(String(resolved));
  }
  if (column.type === "date" || column.type === "timestamp") {
    return resolved instanceof Date ? resolved.getTime() : new Date(String(resolved)).getTime();
  }
  return resolved;
}

function resolveReferenceValue(value: unknown): unknown {
  if (value instanceof FragnoReference) {
    return value.internalId;
  }
  if (value instanceof FragnoId) {
    return value;
  }
  return value;
}

function compareValues(left: unknown, right: unknown): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  if (typeof left === "bigint" || typeof right === "bigint") {
    const leftBigint = BigInt(String(left));
    const rightBigint = BigInt(String(right));
    return leftBigint < rightBigint ? -1 : leftBigint > rightBigint ? 1 : 0;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const leftString = String(left);
  const rightString = String(right);
  return leftString < rightString ? -1 : leftString > rightString ? 1 : 0;
}

function evaluateStringComparison(left: string, operator: Operator, right: string): boolean {
  switch (operator) {
    case "contains":
      return left.includes(right);
    case "not contains":
      return !left.includes(right);
    case "starts with":
      return left.startsWith(right);
    case "not starts with":
      return !left.startsWith(right);
    case "ends with":
      return left.endsWith(right);
    case "not ends with":
      return !left.endsWith(right);
    default:
      throw new Error(`Unsupported string comparison operator ${operator}`);
  }
}

function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}
