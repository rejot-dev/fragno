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
  DynamoDBCheckPlan,
  DynamoDBCommandPlan,
  DynamoDBCreatePlan,
  DynamoDBDeletePlan,
  DynamoDBFindPlan,
  DynamoDBUpdatePlan,
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

type MutationPreflight =
  | {
      success: true;
      transactionActions: TransactionAction[];
      createdInternalIds: (bigint | null)[];
    }
  | { success: false };

type TransactionAction = {
  item: object;
  conditionFailure: "constraint" | "occ";
};

type ExistingRow = BaseRowItem & {
  pk: string;
  _internalId: string;
  _version: number;
};

type BaseWritePlan = DynamoDBCreatePlan | DynamoDBUpdatePlan | DynamoDBDeletePlan;

type RowMutationGroup = {
  key: string;
  tableName: string;
  externalId: string;
  writes: BaseWritePlan[];
  checks: DynamoDBCheckPlan[];
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

    const preflight = await this.#preflightMutations(
      mutationBatch.map((mutation) => mutation.query),
    );
    if (!preflight.success) {
      return { success: false };
    }
    if (preflight.transactionActions.length === 0) {
      return { success: true, createdInternalIds: preflight.createdInternalIds };
    }
    if (preflight.transactionActions.length > DYNAMODB_TRANSACTION_ACTION_LIMIT) {
      throw new Error(
        `DynamoDB transaction has ${preflight.transactionActions.length} actions; maximum is ${DYNAMODB_TRANSACTION_ACTION_LIMIT}.`,
      );
    }

    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: preflight.transactionActions.map((action) => action.item),
        }),
      );
    } catch (error) {
      if (isOccTransactionCancellation(error, preflight.transactionActions)) {
        return { success: false };
      }
      throw error;
    }

    return {
      success: true,
      createdInternalIds: preflight.createdInternalIds,
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

  async #preflightMutations(plans: readonly DynamoDBCommandPlan[]): Promise<MutationPreflight> {
    const groups = groupMutationsByRow(plans);
    const existingRows = await this.#readExistingRows(groups);
    const transactionActions: TransactionAction[] = [];
    const createdInternalIds: (bigint | null)[] = [];

    const createPlans = plans.filter((plan): plan is DynamoDBCreatePlan => plan.kind === "create");
    const createReservations = await this.#reserveInternalIds(createPlans);
    const reservationByPlan = new Map(
      createReservations.map((reservation) => [reservation.plan, reservation.internalId] as const),
    );

    for (const group of groups.values()) {
      const write = group.writes[0];
      const existingRow = existingRows.get(group.key);
      if (!write) {
        if (!this.#checksPass(group.checks, existingRow)) {
          return { success: false };
        }
        transactionActions.push(this.#checkTransactItem(group.checks[0]!));
        continue;
      }

      if (write.kind === "create") {
        if (group.checks.length > 0) {
          throw new Error(
            `DynamoDB mutation batch cannot combine create and check for ${write.tableName}.${write.externalId}.`,
          );
        }
        const internalId = reservationByPlan.get(write);
        if (internalId === undefined) {
          throw new Error(`Failed to reserve DynamoDB internal ID for ${write.tableName}.`);
        }
        transactionActions.push(...this.#createTransactItems(write, internalId));
        continue;
      }

      if (!this.#writePreconditionsPass(write, group.checks, existingRow)) {
        return { success: false };
      }

      if (write.kind === "update") {
        if (!existingRow) {
          continue;
        }
        transactionActions.push(this.#updateTransactItem(write, existingRow, group.checks));
        continue;
      }

      if (write.kind === "delete") {
        if (!existingRow) {
          continue;
        }
        transactionActions.push(...this.#deleteTransactItems(write, group.checks));
        continue;
      }
    }

    for (const plan of plans) {
      if (plan.kind === "create") {
        createdInternalIds.push(reservationByPlan.get(plan) ?? null);
      }
    }

    return { success: true, transactionActions, createdInternalIds };
  }

  async #readExistingRows(
    groups: Map<string, RowMutationGroup>,
  ): Promise<Map<string, ExistingRow>> {
    const rows = new Map<string, ExistingRow>();
    for (const group of groups.values()) {
      if (group.writes[0]?.kind === "create") {
        continue;
      }
      const plan = group.writes[0] ?? group.checks[0];
      if (!plan) {
        continue;
      }
      const row = await this.#getExistingRow(plan.layout.baseTableName, group.externalId);
      if (row) {
        rows.set(group.key, row);
      }
    }
    return rows;
  }

  async #getExistingRow(baseTableName: string, externalId: string): Promise<ExistingRow | null> {
    const result = (await this.#client.send(
      new GetCommand({
        TableName: baseTableName,
        Key: { pk: externalId },
        ConsistentRead: true,
      }),
    )) as { Item?: BaseRowItem };

    if (!result.Item) {
      return null;
    }
    return normalizeExistingRow(result.Item, baseTableName, externalId);
  }

  #checksPass(checks: readonly DynamoDBCheckPlan[], row: ExistingRow | null | undefined): boolean {
    if (checks.length === 0) {
      return true;
    }
    if (!row) {
      return false;
    }
    return checks.every((check) => row._version === check.expectedVersion);
  }

  #writePreconditionsPass(
    write: DynamoDBUpdatePlan | DynamoDBDeletePlan,
    checks: readonly DynamoDBCheckPlan[],
    row: ExistingRow | null | undefined,
  ): boolean {
    if (!row) {
      return write.expectedVersion === undefined && checks.length === 0;
    }
    if (write.expectedVersion !== undefined && row._version !== write.expectedVersion) {
      return false;
    }
    return this.#checksPass(checks, row);
  }

  #checkTransactItem(plan: DynamoDBCheckPlan): TransactionAction {
    return {
      conditionFailure: "occ",
      item: {
        ConditionCheck: {
          TableName: plan.layout.baseTableName,
          Key: { pk: plan.externalId },
          ConditionExpression: "attribute_exists(#pk) AND #version = :expectedVersion",
          ExpressionAttributeNames: { "#pk": "pk", "#version": "_version" },
          ExpressionAttributeValues: { ":expectedVersion": plan.expectedVersion },
        },
      },
    };
  }

  #updateTransactItem(
    plan: DynamoDBUpdatePlan,
    existingRow: ExistingRow,
    checks: readonly DynamoDBCheckPlan[],
  ): TransactionAction {
    const forbiddenColumn = Object.keys(plan.set).find(
      (columnName) =>
        columnName === "id" || columnName === "_internalId" || columnName === "_version",
    );
    if (forbiddenColumn) {
      throw new Error(
        `DynamoDB update cannot change managed column ${plan.tableName}.${forbiddenColumn}.`,
      );
    }

    const expressionAttributeNames: Record<string, string> = {
      "#pk": "pk",
      "#version": "_version",
    };
    const expressionAttributeValues: Record<string, unknown> = {
      ":versionIncrement": 1,
    };
    const setExpressions = ["#version = #version + :versionIncrement"];

    let index = 0;
    for (const [columnName, value] of Object.entries(plan.set)) {
      index += 1;
      const nameKey = `#set${index}`;
      const valueKey = `:set${index}`;
      expressionAttributeNames[nameKey] = columnName;
      expressionAttributeValues[valueKey] = value;
      setExpressions.push(`${nameKey} = ${valueKey}`);
    }

    const expectedVersion = coalescedExpectedVersion(plan, checks);
    const condition =
      expectedVersion === undefined
        ? "attribute_exists(#pk)"
        : "attribute_exists(#pk) AND #version = :expectedVersion";
    if (expectedVersion !== undefined) {
      expressionAttributeValues[":expectedVersion"] = expectedVersion;
    }

    const nextRow = { ...existingRow, ...plan.set, _version: existingRow._version + 1 };
    assertDynamoDBItemSize(nextRow);

    return {
      conditionFailure: "occ",
      item: {
        Update: {
          TableName: plan.layout.baseTableName,
          Key: { pk: plan.externalId },
          UpdateExpression: `SET ${setExpressions.join(", ")}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
        },
      },
    };
  }

  #deleteTransactItems(
    plan: DynamoDBDeletePlan,
    checks: readonly DynamoDBCheckPlan[],
  ): TransactionAction[] {
    const expressionAttributeValues: Record<string, unknown> = {};
    const expressionAttributeNames = { "#pk": "pk", "#version": "_version" };
    const expectedVersion = coalescedExpectedVersion(plan, checks);
    const condition =
      expectedVersion === undefined
        ? "attribute_exists(#pk)"
        : "attribute_exists(#pk) AND #version = :expectedVersion";
    if (expectedVersion !== undefined) {
      expressionAttributeValues[":expectedVersion"] = expectedVersion;
    }

    return [
      {
        conditionFailure: "occ",
        item: {
          Delete: {
            TableName: plan.layout.baseTableName,
            Key: { pk: plan.externalId },
            ConditionExpression: condition,
            ExpressionAttributeNames:
              expectedVersion === undefined ? { "#pk": "pk" } : expressionAttributeNames,
            ...(Object.keys(expressionAttributeValues).length > 0
              ? { ExpressionAttributeValues: expressionAttributeValues }
              : {}),
          },
        },
      },
      {
        conditionFailure: "constraint",
        item: {
          Delete: {
            TableName: plan.layout.indexTableName,
            Key: {
              pk: `idx#${PRIMARY_INDEX_NAME}`,
              sk: createPrimaryIndexSortKey(plan),
            },
          },
        },
      },
    ];
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
            ExpressionAttributeNames:
              currentValue === undefined
                ? { "#pk": "pk", "#value": "value" }
                : { "#value": "value" },
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

  #createTransactItems(plan: DynamoDBCreatePlan, internalId: bigint): TransactionAction[] {
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
        conditionFailure: "constraint",
        item: {
          Put: {
            TableName: plan.layout.baseTableName,
            Item: baseRow,
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          },
        },
      },
      {
        conditionFailure: "constraint",
        item: {
          Put: {
            TableName: plan.layout.indexTableName,
            Item: primaryIndexEntry,
            ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
            ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          },
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
  const sk = createPrimaryIndexSortKey(plan);
  return {
    pk: `idx#${PRIMARY_INDEX_NAME}`,
    sk,
    externalId: decodeDynamoDBIndexEntry(sk).externalId,
    internalId: internalId.toString(),
  };
}

function createPrimaryIndexSortKey(plan: DynamoDBCreatePlan | DynamoDBDeletePlan): string {
  const idColumn = plan.table.getIdColumn();
  return encodeDynamoDBIndexEntry([{ column: idColumn, value: plan.externalId }], plan.externalId);
}

function groupMutationsByRow(plans: readonly DynamoDBCommandPlan[]): Map<string, RowMutationGroup> {
  const groups = new Map<string, RowMutationGroup>();

  for (const plan of plans) {
    if (plan.kind === "find" || plan.kind === "count") {
      throw new Error(`DynamoDB ${plan.kind} plan cannot be executed in mutation phase.`);
    }

    const key = mutationRowKey(plan);
    const group = groups.get(key) ?? {
      key,
      tableName: plan.tableName,
      externalId: plan.externalId,
      writes: [],
      checks: [],
    };

    if (plan.kind === "check") {
      if (group.checks.some((check) => check.expectedVersion !== plan.expectedVersion)) {
        throw new Error(
          `DynamoDB mutation batch contains conflicting checks for ${plan.tableName}.${plan.externalId}.`,
        );
      }
      group.checks.push(plan);
    } else {
      group.writes.push(plan);
      if (group.writes.length > 1) {
        throw new Error(
          `DynamoDB mutation batch contains multiple writes to ${plan.tableName}.${plan.externalId}; DynamoDB transactions cannot target the same item more than once.`,
        );
      }
    }

    groups.set(key, group);
  }

  return groups;
}

function mutationRowKey(
  plan: DynamoDBCreatePlan | DynamoDBUpdatePlan | DynamoDBDeletePlan | DynamoDBCheckPlan,
): string {
  return `${plan.layout.baseTableName}\0${plan.externalId}`;
}

function normalizeExistingRow(
  item: BaseRowItem,
  baseTableName: string,
  externalId: string,
): ExistingRow {
  if (typeof item.pk !== "string") {
    throw new Error(`DynamoDB row ${baseTableName}.${externalId} has invalid pk.`);
  }
  if (typeof item._internalId !== "string") {
    throw new Error(`DynamoDB row ${baseTableName}.${externalId} has invalid _internalId.`);
  }
  if (typeof item._version !== "number") {
    throw new Error(`DynamoDB row ${baseTableName}.${externalId} has invalid _version.`);
  }
  return item as ExistingRow;
}

function coalescedExpectedVersion(
  plan: DynamoDBUpdatePlan | DynamoDBDeletePlan,
  checks: readonly DynamoDBCheckPlan[],
): number | undefined {
  const checkVersion = checks[0]?.expectedVersion;
  if (
    plan.expectedVersion !== undefined &&
    checkVersion !== undefined &&
    plan.expectedVersion !== checkVersion
  ) {
    throw new Error(
      `DynamoDB mutation batch contains conflicting expected versions for ${plan.tableName}.${plan.externalId}.`,
    );
  }
  return plan.expectedVersion ?? checkVersion;
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

function isOccTransactionCancellation(
  error: unknown,
  actions: readonly TransactionAction[],
): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") {
    return false;
  }

  const reasons = getCancellationReasons(error);
  if (reasons.length === actions.length) {
    let hasOccFailure = false;
    for (let index = 0; index < reasons.length; index += 1) {
      const reason = reasons[index];
      if (!reason || reason.Code === "None") {
        continue;
      }
      if (reason.Code !== "ConditionalCheckFailed") {
        return false;
      }
      if (actions[index]?.conditionFailure === "constraint") {
        return false;
      }
      hasOccFailure = true;
    }
    return hasOccFailure;
  }

  return (
    actions.some((action) => action.conditionFailure === "occ") &&
    actions.every((action) => action.conditionFailure === "occ")
  );
}

function getCancellationReasons(error: Error): Array<{ Code?: string }> {
  const reasons = (error as Error & { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) {
    return [];
  }
  return reasons.filter(
    (reason): reason is { Code?: string } =>
      typeof reason === "object" &&
      reason !== null &&
      (!Object.prototype.hasOwnProperty.call(reason, "Code") ||
        typeof (reason as { Code?: unknown }).Code === "string"),
  );
}
