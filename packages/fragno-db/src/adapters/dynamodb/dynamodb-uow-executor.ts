import superjson from "superjson";

import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { internalSchema } from "../../fragments/internal-fragment.schema";
import { createId } from "../../id";
import {
  encodeVersionstamp,
  parseOutboxVersionValue,
  type OutboxConfig,
  type OutboxRefLookup,
  type OutboxRefMap,
  versionstampToHex,
} from "../../outbox/outbox";
import {
  buildOutboxPlan,
  finalizeOutboxPayload,
  type OutboxPlan,
} from "../../outbox/outbox-builder";
import type { Condition, Operator } from "../../query/condition-builder";
import { decodeCursor } from "../../query/cursor";
import {
  getQueryTreeSelectedColumnNames,
  isParentColumnRef,
  type CompiledQueryTreeChildNode,
  type CompiledQueryTreeRootNode,
} from "../../query/unit-of-work/query-tree";
import type {
  CompiledMutation,
  MutationResult,
  UOWExecutor,
} from "../../query/unit-of-work/unit-of-work";
import {
  encodeValuesWithDbDefaults,
  ReferenceSubquery,
  resolveFragnoIdValue,
} from "../../query/value-encoding";
import type { AnyColumn, AnyTable } from "../../schema/create";
import { FragnoId, FragnoReference, getTableForeignKey } from "../../schema/create";
import {
  decodeDynamoDBIndexEntry,
  encodeDynamoDBIndexEntry,
  encodeDynamoDBIndexTuple,
} from "./dynamodb-index-codec";
import type { DynamoDBTableLayout } from "./dynamodb-layout";
import type { DynamoDBRawResult, DynamoDBRawRow } from "./dynamodb-uow-decoder";
import type {
  DynamoDBCheckPlan,
  DynamoDBCommandPlan,
  DynamoDBCreatePlan,
  DynamoDBDeletePlan,
  DynamoDBFindPlan,
  DynamoDBCountPlan,
  DynamoDBUpdatePlan,
} from "./dynamodb-uow-operation-compiler";
import {
  assertDynamoDBItemSize,
  encodeDynamoDBValue,
  estimateDynamoDBItemSizeBytes,
  type BaseRowItem,
  type DynamoDBAttributeValue,
} from "./dynamodb-value-codec";
import {
  DynamoDBReadLimitError,
  DynamoDBTransactionLimitError,
  DynamoDBUnsupportedQueryError,
} from "./errors";

export interface DynamoDBUOWExecutorOptions {
  client: DynamoDBDocumentClient;
  settingsTableName: string;
  consistentRead?: boolean;
  maxFilteredReadPages?: number;
  allowScans?: boolean;
  outbox?: OutboxConfig;
  internalTableLayouts?: Record<string, DynamoDBTableLayout>;
}

type DynamoDBSendableClient = {
  send(command: object): Promise<unknown>;
};

type CreateReservation = {
  plan: DynamoDBCreatePlan;
  internalId: bigint;
};

type CreatedReferenceMap = Map<string, bigint>;

type MutationPreflight =
  | {
      success: true;
      transactionActions: TransactionAction[];
      createdInternalIds: (bigint | null)[];
      createReservations: CreateReservation[];
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

type QueryRowsOptions = {
  table: AnyTable;
  layout: DynamoDBTableLayout;
  indexName: string;
  orderDirection?: "asc" | "desc";
  exclusiveStartKey?: Record<string, unknown>;
  limit?: number;
  predicate?: (row: DynamoDBRawRow) => boolean;
};

type DynamoDBPlanBaseWithLayouts = {
  tableLayouts: Record<string, DynamoDBTableLayout>;
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
const OUTBOX_VERSION_PK = "outbox_version";
const OUTBOX_VERSION_SK = "global";
const PRIMARY_INDEX_NAME = "_primary";
const DYNAMODB_TRANSACTION_ACTION_LIMIT = 100;
const DYNAMODB_TRANSACTION_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;

export class DynamoDBUOWExecutor implements UOWExecutor<DynamoDBCommandPlan, DynamoDBRawResult> {
  readonly #client: DynamoDBSendableClient;
  readonly #settingsTableName: string;
  readonly #consistentRead: boolean;
  readonly #maxFilteredReadPages: number;
  readonly #allowScans: boolean;
  readonly #outbox?: OutboxConfig;
  readonly #internalTableLayouts: Record<string, DynamoDBTableLayout>;

  constructor(options: DynamoDBUOWExecutorOptions) {
    this.#client = options.client as unknown as DynamoDBSendableClient;
    this.#settingsTableName = options.settingsTableName;
    this.#consistentRead = options.consistentRead ?? true;
    this.#maxFilteredReadPages = options.maxFilteredReadPages ?? 10;
    this.#allowScans = options.allowScans ?? false;
    this.#outbox = options.outbox;
    this.#internalTableLayouts = options.internalTableLayouts ?? {};
  }

  async executeRetrievalPhase(retrievalBatch: DynamoDBCommandPlan[]): Promise<DynamoDBRawResult[]> {
    const results: DynamoDBRawResult[] = [];

    for (const plan of retrievalBatch) {
      if (plan.kind === "find") {
        results.push(await this.#executeFind(plan));
        continue;
      }

      if (plan.kind === "count") {
        results.push(await this.#executeCount(plan));
        continue;
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

    const outbox = this.#buildOutboxContext(mutationBatch);
    const preflight = await this.#preflightMutations(
      mutationBatch.map((mutation) => mutation.query),
    );
    if (!preflight.success) {
      return { success: false };
    }

    const transactionActions = [...preflight.transactionActions];
    if (outbox.shouldWrite) {
      transactionActions.push(
        ...(await this.#createOutboxTransactItems(
          mutationBatch,
          outbox.plan,
          preflight.createReservations,
        )),
      );
    }

    if (transactionActions.length === 0) {
      return { success: true, createdInternalIds: preflight.createdInternalIds };
    }
    assertDynamoDBTransactionLimits(transactionActions);

    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: transactionActions.map((action) => action.item),
        }),
      );
    } catch (error) {
      if (isOccTransactionCancellation(error, transactionActions)) {
        return { success: false };
      }
      throw error;
    }

    return {
      success: true,
      createdInternalIds: preflight.createdInternalIds,
    };
  }

  #buildOutboxContext(
    mutationBatch: readonly CompiledMutation<DynamoDBCommandPlan>[],
  ): { shouldWrite: false; plan: null } | { shouldWrite: true; plan: OutboxPlan } {
    const outboxEnabled = this.#outbox?.enabled ?? false;
    if (!outboxEnabled) {
      return { shouldWrite: false, plan: null };
    }

    const shouldInclude = this.#outbox?.shouldInclude;
    const operations = mutationBatch.flatMap((mutation) => {
      const operation = mutation.operation;
      if (!operation) {
        return [];
      }
      if (shouldInclude && !shouldInclude(operation)) {
        return [];
      }
      return [operation];
    });
    const plan = operations.length > 0 ? buildOutboxPlan(operations) : null;
    if (!plan || plan.drafts.length === 0) {
      return { shouldWrite: false, plan: null };
    }
    return { shouldWrite: true, plan };
  }

  async #executeFind(plan: DynamoDBFindPlan): Promise<DynamoDBRawRow[]> {
    if (plan.queryTree) {
      return this.#executeQueryTreeFind(plan, plan.queryTree);
    }

    this.#assertQuerySupported(plan.table, plan.indexName, plan.condition);
    const condition = await this.#resolveReferenceCondition(plan, plan.condition);
    const limit =
      plan.withCursor && plan.pageSize !== undefined ? plan.pageSize + 1 : plan.pageSize;
    const rows = await this.#queryRowsByIndex({
      table: plan.table,
      layout: plan.layout,
      indexName: plan.indexName,
      orderDirection: plan.orderDirection,
      exclusiveStartKey: createCursorExclusiveStartKey(plan),
      limit,
      predicate: (row) => !condition || evaluateDynamoDBCondition(condition, plan.table, row),
    });

    return rows.map((row) => selectDynamoDBRow(row, plan.table, plan.selectedColumns));
  }

  async #executeCount(plan: DynamoDBCountPlan): Promise<{ count: number }[]> {
    this.#assertQuerySupported(plan.table, plan.indexName, plan.condition);
    if (!plan.condition) {
      const result = (await this.#client.send(
        new QueryCommand({
          TableName: plan.layout.indexTableName,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": `idx#${plan.indexName}` },
          ConsistentRead: this.#consistentRead,
          Select: "COUNT",
        }),
      )) as { Count?: number };
      return [{ count: result.Count ?? 0 }];
    }

    const condition = await this.#resolveReferenceCondition(plan, plan.condition);
    let count = 0;
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    let pagesRead = 0;
    do {
      pagesRead += 1;
      if (pagesRead > this.#maxFilteredReadPages) {
        throw new DynamoDBReadLimitError(
          `DynamoDB read limit exceeded for ${plan.tableName}.${plan.indexName}; increase maxFilteredReadPages to count more filtered pages.`,
        );
      }
      const queryResult = (await this.#client.send(
        new QueryCommand({
          TableName: plan.layout.indexTableName,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": `idx#${plan.indexName}` },
          ConsistentRead: this.#consistentRead,
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      )) as { Items?: DynamoDBIndexEntryItem[]; LastEvaluatedKey?: Record<string, unknown> };
      const rows = await this.#batchGetRows(
        plan,
        (queryResult.Items ?? []).map((entry) => entry.externalId),
      );
      count += rows.filter(
        (row) => condition && evaluateDynamoDBCondition(condition, plan.table, row),
      ).length;
      lastEvaluatedKey = queryResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return [{ count }];
  }

  async #batchGetRows(
    plan: DynamoDBFindPlan | DynamoDBCountPlan,
    externalIds: readonly string[],
  ): Promise<DynamoDBRawRow[]> {
    return this.#batchGetRowsFromLayout(plan.layout, externalIds);
  }

  async #batchGetRowsFromLayout(
    layout: DynamoDBTableLayout,
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
            [layout.baseTableName]: {
              Keys: chunk.map((externalId) => ({ pk: externalId })),
              ConsistentRead: this.#consistentRead,
            },
          },
        }),
      )) as { Responses?: Record<string, DynamoDBRawRow[]> };

      for (const row of result.Responses?.[layout.baseTableName] ?? []) {
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

  async #queryRowsByIndex(options: QueryRowsOptions): Promise<DynamoDBRawRow[]> {
    const matchedRows: DynamoDBRawRow[] = [];
    let lastEvaluatedKey = options.exclusiveStartKey;
    let pagesRead = 0;

    do {
      pagesRead += 1;
      if (pagesRead > this.#maxFilteredReadPages) {
        throw new DynamoDBReadLimitError(
          `DynamoDB read limit exceeded for ${options.table.name}.${options.indexName}; increase maxFilteredReadPages to read more filtered pages.`,
        );
      }

      const queryResult = (await this.#client.send(
        new QueryCommand({
          TableName: options.layout.indexTableName,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": `idx#${options.indexName}` },
          ConsistentRead: this.#consistentRead,
          ScanIndexForward: options.orderDirection !== "desc",
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      )) as { Items?: DynamoDBIndexEntryItem[]; LastEvaluatedKey?: Record<string, unknown> };

      const rows = await this.#batchGetRowsFromLayout(
        options.layout,
        (queryResult.Items ?? []).map((entry) => entry.externalId),
      );
      for (const row of rows) {
        if (options.predicate && !options.predicate(row)) {
          continue;
        }
        matchedRows.push(row);
        if (options.limit !== undefined && matchedRows.length >= options.limit) {
          return matchedRows;
        }
      }

      lastEvaluatedKey = queryResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return matchedRows;
  }

  #assertQuerySupported(
    table: AnyTable,
    indexName: string,
    condition: Condition | undefined,
  ): void {
    if (
      this.#allowScans ||
      hasEqualityConditionForLeadingIndexColumn(table, indexName, condition)
    ) {
      return;
    }

    throw new DynamoDBUnsupportedQueryError(
      `DynamoDB query for ${table.name}.${indexName} requires an equality condition on the leading index column; set allowScans to true to permit bounded index scans.`,
    );
  }

  async #executeQueryTreeFind(
    plan: DynamoDBFindPlan,
    root: CompiledQueryTreeRootNode,
  ): Promise<DynamoDBRawRow[]> {
    this.#assertQuerySupported(root.table, root.useIndex, root.where);
    const condition = await this.#resolveReferenceCondition(plan, root.where);
    const limit =
      plan.withCursor && root.pageSize !== undefined ? root.pageSize + 1 : root.pageSize;
    const rows = await this.#queryRowsByIndex({
      table: root.table,
      layout: plan.layout,
      indexName: root.useIndex,
      orderDirection: root.orderByIndex?.direction ?? plan.orderDirection,
      exclusiveStartKey: createCursorExclusiveStartKey(plan),
      limit,
      predicate: (row) => !condition || evaluateDynamoDBCondition(condition, root.table, row),
    });

    const rawRows: DynamoDBRawRow[] = [];
    for (const row of rows) {
      rawRows.push(await this.#buildQueryTreeRowRaw(plan, root, row));
    }
    return rawRows;
  }

  async #buildQueryTreeRowRaw(
    plan: DynamoDBFindPlan,
    node: CompiledQueryTreeRootNode | CompiledQueryTreeChildNode,
    row: DynamoDBRawRow,
  ): Promise<DynamoDBRawRow> {
    const selected = selectDynamoDBQueryTreeRow(
      row,
      node.table,
      node.select,
      plan.readTracking ? [node.table.getIdColumn().name] : [],
    );

    for (const child of node.children) {
      selected[child.alias] = await this.#buildQueryTreeChildValue(plan, child, node.table, row);
    }

    return selected;
  }

  async #buildQueryTreeChildValue(
    plan: DynamoDBFindPlan,
    child: CompiledQueryTreeChildNode,
    parentTable: AnyTable,
    parentRow: DynamoDBRawRow,
  ): Promise<unknown> {
    const layout = plan.tableLayouts[child.table.name];
    if (!layout) {
      throw new Error(`Missing DynamoDB layout for query-tree table ${child.table.name}.`);
    }
    this.#assertQuerySupported(child.table, child.onIndexName, child.onIndex);
    const onIndex = await this.#resolveReferenceConditionForTable(child.table, plan, child.onIndex);
    const where = await this.#resolveReferenceConditionForTable(child.table, plan, child.where);
    const orderByDifferentIndex =
      child.orderByIndex !== undefined && child.orderByIndex.indexName !== child.onIndexName;
    const rows = await this.#queryRowsByIndex({
      table: child.table,
      layout,
      indexName: child.onIndexName,
      orderDirection: child.orderByIndex?.direction ?? "asc",
      limit: orderByDifferentIndex ? undefined : child.pageSize,
      predicate: (row) =>
        evaluateDynamoDBCondition(onIndex, child.table, row, parentTable, parentRow) &&
        (!where || evaluateDynamoDBCondition(where, child.table, row)),
    });

    const ordered = orderByDifferentIndex
      ? orderDynamoDBRows(rows, child.table, child.orderByIndex!)
      : rows;
    const limited = child.pageSize !== undefined ? ordered.slice(0, child.pageSize) : ordered;
    const items = [];
    for (const row of limited) {
      items.push(await this.#buildQueryTreeRowRaw(plan, child, row));
    }

    if (child.cardinality === "one") {
      return items[0] ?? null;
    }
    return items;
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
    const createdReferences = createCreatedReferenceMap(createReservations);

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
        transactionActions.push(
          ...(await this.#createTransactItems(write, internalId, createdReferences)),
        );
        continue;
      }

      if (!this.#writePreconditionsPass(write, group.checks, existingRow)) {
        return { success: false };
      }

      if (write.kind === "update") {
        if (!existingRow) {
          continue;
        }
        transactionActions.push(
          ...(await this.#updateTransactItems(write, existingRow, group.checks, createdReferences)),
        );
        continue;
      }

      if (write.kind === "delete") {
        if (!existingRow) {
          continue;
        }
        transactionActions.push(...this.#deleteTransactItems(write, existingRow, group.checks));
        continue;
      }
    }

    for (const plan of plans) {
      if (plan.kind === "create") {
        createdInternalIds.push(reservationByPlan.get(plan) ?? null);
      }
    }

    return { success: true, transactionActions, createdInternalIds, createReservations };
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

  async #updateTransactItems(
    plan: DynamoDBUpdatePlan,
    existingRow: ExistingRow,
    checks: readonly DynamoDBCheckPlan[],
    createdReferences: CreatedReferenceMap,
  ): Promise<TransactionAction[]> {
    const forbiddenColumn = Object.keys(plan.set).find(
      (columnName) =>
        columnName === "id" || columnName === "_internalId" || columnName === "_version",
    );
    if (forbiddenColumn) {
      throw new Error(
        `DynamoDB update cannot change managed column ${plan.tableName}.${forbiddenColumn}.`,
      );
    }

    const set = await this.#resolvePlanAttributes(plan, plan.set, createdReferences);
    const expressionAttributeNames: Record<string, string> = {
      "#pk": "pk",
      "#version": "_version",
    };
    const expressionAttributeValues: Record<string, unknown> = {
      ":versionIncrement": 1,
    };
    const setExpressions = ["#version = #version + :versionIncrement"];

    let index = 0;
    for (const [columnName, value] of Object.entries(set)) {
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

    const nextRow = { ...existingRow, ...set, _version: existingRow._version + 1 };
    assertDynamoDBItemSize(nextRow);

    return [
      {
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
      },
      ...createChangedSecondaryIndexActions(plan, existingRow, nextRow),
    ];
  }

  #deleteTransactItems(
    plan: DynamoDBDeletePlan,
    existingRow: ExistingRow,
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
      ...createDeleteIndexActions(plan, existingRow),
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

  async #createTransactItems(
    plan: DynamoDBCreatePlan,
    internalId: bigint,
    createdReferences: CreatedReferenceMap,
  ): Promise<TransactionAction[]> {
    const item = await this.#resolvePlanAttributes(plan, plan.item, createdReferences);
    const baseRow: BaseRowItem = {
      pk: plan.externalId,
      ...item,
      id: plan.externalId,
      _internalId: internalId.toString(),
      _version: 0,
    };
    const indexActions = createPutIndexActions(plan, baseRow, internalId);

    assertDynamoDBItemSize(baseRow);

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
      ...indexActions,
    ];
  }

  async #createOutboxTransactItems(
    mutationBatch: readonly CompiledMutation<DynamoDBCommandPlan>[],
    outboxPlan: OutboxPlan,
    createReservations: readonly CreateReservation[],
  ): Promise<TransactionAction[]> {
    const uowId = mutationBatch[0]?.uowId;
    if (!uowId) {
      throw new Error("Outbox mutation batch is missing uowId.");
    }

    const versionReservation = await this.#reserveOutboxVersionTransactItem();
    const refMap = await this.#resolveOutboxRefMap(
      outboxPlan.lookups,
      mutationBatch,
      createReservations,
    );
    const payload = finalizeOutboxPayload(outboxPlan, versionReservation.version);
    const payloadSerialized = superjson.serialize(payload);
    const versionstamp = versionstampToHex(encodeVersionstamp(versionReservation.version, 0));

    const outboxPlans = [
      ...payload.mutations.map((mutation) =>
        this.#createInternalCreatePlan("fragno_db_outbox_mutations", {
          entryVersionstamp: versionstamp,
          mutationVersionstamp: mutation.versionstamp,
          uowId,
          schema: mutation.schema,
          table: mutation.table,
          externalId: mutation.externalId,
          op: mutation.op,
        }),
      ),
      this.#createInternalCreatePlan("fragno_db_outbox", {
        versionstamp,
        uowId,
        payload: payloadSerialized,
        refMap: refMap ?? null,
      }),
    ];
    const outboxReservations = await this.#reserveInternalIds(outboxPlans);
    const outboxCreatedReferences = createCreatedReferenceMap([
      ...createReservations,
      ...outboxReservations,
    ]);
    const actions: TransactionAction[] = [versionReservation.action];
    for (const reservation of outboxReservations) {
      actions.push(
        ...(await this.#createTransactItems(
          reservation.plan,
          reservation.internalId,
          outboxCreatedReferences,
        )),
      );
    }
    return actions;
  }

  async #reserveOutboxVersionTransactItem(): Promise<{
    version: bigint;
    action: TransactionAction;
  }> {
    const currentValue = await this.#readOutboxVersionValue();
    const current = currentValue === undefined ? undefined : parseOutboxVersionValue(currentValue);
    const next = current === undefined ? 0n : current + 1n;

    return {
      version: next,
      action: {
        conditionFailure: "occ",
        item: {
          Update: {
            TableName: this.#settingsTableName,
            Key: { pk: OUTBOX_VERSION_PK, sk: OUTBOX_VERSION_SK },
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
          },
        },
      },
    };
  }

  async #readOutboxVersionValue(): Promise<string | undefined> {
    const result = (await this.#client.send(
      new GetCommand({
        TableName: this.#settingsTableName,
        Key: { pk: OUTBOX_VERSION_PK, sk: OUTBOX_VERSION_SK },
        ConsistentRead: true,
      }),
    )) as { Item?: { value?: unknown } };

    const value = result.Item?.value;
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error("DynamoDB outbox version value is not a string.");
    }
    return value;
  }

  #createInternalCreatePlan(
    tableName: "fragno_db_outbox" | "fragno_db_outbox_mutations",
    values: Record<string, unknown>,
  ): DynamoDBCreatePlan {
    const table = internalSchema.tables[tableName];
    const layout = this.#internalTableLayouts[tableName];
    if (!table || !layout) {
      throw new Error(`Missing DynamoDB internal table layout for ${tableName}.`);
    }
    return {
      kind: "create",
      schemaName: internalSchema.name,
      namespace: internalSchema.name,
      tableName,
      table,
      layout,
      tableLayouts: this.#internalTableLayouts,
      externalId: createId(),
      item: encodeDynamoDBCreateItem(values, table),
    };
  }

  async #resolveOutboxRefMap(
    lookups: readonly OutboxRefLookup[],
    mutationBatch: readonly CompiledMutation<DynamoDBCommandPlan>[],
    createReservations: readonly CreateReservation[],
  ): Promise<OutboxRefMap | undefined> {
    if (lookups.length === 0) {
      return undefined;
    }

    const refMap: OutboxRefMap = {};
    for (const lookup of lookups) {
      const createdExternalId = findCreatedOutboxReference(lookup, createReservations);
      if (createdExternalId !== undefined) {
        refMap[lookup.key] = createdExternalId;
        continue;
      }

      const layout = findOutboxLookupLayout(lookup, mutationBatch);
      if (!layout) {
        throw new Error(
          `Failed to resolve DynamoDB layout for outbox lookup on ${lookup.table.name}.`,
        );
      }
      const rows = await this.#queryRowsByIndex({
        table: lookup.table,
        layout,
        indexName: PRIMARY_INDEX_NAME,
        limit: 1,
        predicate: (row) => row["_internalId"] === String(lookup.internalId),
      });
      const externalId = rows[0]?.[lookup.table.getIdColumn().name];
      if (typeof externalId !== "string") {
        throw new Error(
          `Failed to resolve outbox reference for ${lookup.table.name}._internalId=${String(lookup.internalId)}`,
        );
      }
      refMap[lookup.key] = externalId;
    }

    return Object.keys(refMap).length > 0 ? refMap : undefined;
  }

  async #resolvePlanAttributes(
    plan: DynamoDBCreatePlan | DynamoDBUpdatePlan,
    values: Record<string, unknown>,
    createdReferences: CreatedReferenceMap,
  ): Promise<Record<string, DynamoDBAttributeValue>> {
    const resolved: Record<string, DynamoDBAttributeValue> = {};
    for (const [columnName, value] of Object.entries(values)) {
      const column = plan.table.columns[columnName];
      if (!column) {
        continue;
      }
      if (value instanceof ReferenceSubquery) {
        const internalId = await this.#resolveReferenceSubquery(plan, value, createdReferences);
        const encoded = encodeDynamoDBValue(internalId, column);
        if (encoded !== undefined) {
          resolved[columnName] = encoded;
        }
        continue;
      }
      resolved[columnName] = value as DynamoDBAttributeValue;
    }
    return resolved;
  }

  async #resolveReferenceSubquery(
    plan: DynamoDBPlanBaseWithLayouts,
    reference: ReferenceSubquery,
    createdReferences: CreatedReferenceMap,
  ): Promise<bigint> {
    const layout = plan.tableLayouts[reference.referencedTable.name];
    if (!layout) {
      throw new Error(
        `Missing DynamoDB layout for referenced table ${reference.referencedTable.name}.`,
      );
    }

    const created = createdReferences.get(createdReferenceKey(layout, reference.externalIdValue));
    if (created !== undefined) {
      return created;
    }

    const row = await this.#getExistingRow(layout.baseTableName, reference.externalIdValue);
    if (!row) {
      throw new Error(
        `Foreign key constraint violation: referenced row ${reference.referencedTable.name}.${reference.externalIdValue} was not found.`,
      );
    }
    return BigInt(row._internalId);
  }

  async #resolveReferenceCondition(
    plan: DynamoDBFindPlan | DynamoDBCountPlan,
    condition: Condition | undefined,
  ): Promise<Condition | undefined> {
    return this.#resolveReferenceConditionForTable(plan.table, plan, condition);
  }

  async #resolveReferenceConditionForTable(
    table: AnyTable,
    plan: DynamoDBPlanBaseWithLayouts,
    condition: Condition | undefined,
  ): Promise<Condition | undefined> {
    if (!condition) {
      return undefined;
    }

    switch (condition.type) {
      case "and":
        return {
          ...condition,
          items: await Promise.all(
            condition.items.map(
              async (item) => (await this.#resolveReferenceConditionForTable(table, plan, item))!,
            ),
          ),
        };
      case "or":
        return {
          ...condition,
          items: await Promise.all(
            condition.items.map(
              async (item) => (await this.#resolveReferenceConditionForTable(table, plan, item))!,
            ),
          ),
        };
      case "not":
        return {
          ...condition,
          item: (await this.#resolveReferenceConditionForTable(table, plan, condition.item))!,
        };
      case "compare":
        if (condition.a.role !== "reference") {
          return condition;
        }
        return {
          ...condition,
          b: await this.#resolveReferenceConditionValue(table, plan, condition.a, condition.b),
        };
    }
  }

  async #resolveReferenceConditionValue(
    table: AnyTable,
    plan: DynamoDBPlanBaseWithLayouts,
    column: AnyColumn,
    value: unknown,
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(
        value.map((item) => this.#resolveReferenceConditionValue(table, plan, column, item)),
      );
    }
    if (isParentColumnRef(value) || value instanceof FragnoReference) {
      return value;
    }
    if (value instanceof FragnoId && value.internalId !== undefined) {
      return value;
    }

    const externalId =
      typeof value === "string" ? value : value instanceof FragnoId ? value.externalId : undefined;
    if (!externalId) {
      return value;
    }

    const foreignKey = getTableForeignKey(table, column.name);
    const referencedTable = foreignKey?.referencedTable;
    if (!referencedTable) {
      return value;
    }
    const layout = plan.tableLayouts[referencedTable.name];
    if (!layout) {
      return value;
    }
    const row = await this.#getExistingRow(layout.baseTableName, externalId);
    return row ? BigInt(row._internalId) : -1n;
  }
}

interface DynamoDBIndexEntryItem {
  pk: string;
  sk: string;
  externalId: string;
  internalId: string;
}

function createCreatedReferenceMap(
  reservations: readonly CreateReservation[],
): CreatedReferenceMap {
  const map: CreatedReferenceMap = new Map();
  for (const reservation of reservations) {
    map.set(
      createdReferenceKey(reservation.plan.layout, reservation.plan.externalId),
      reservation.internalId,
    );
  }
  return map;
}

function createdReferenceKey(layout: DynamoDBTableLayout, externalId: string): string {
  return `${layout.baseTableName}\0${externalId}`;
}

function assertDynamoDBTransactionLimits(actions: readonly TransactionAction[]): void {
  if (actions.length > DYNAMODB_TRANSACTION_ACTION_LIMIT) {
    throw new DynamoDBTransactionLimitError(
      `DynamoDB transaction has ${actions.length} actions; maximum is ${DYNAMODB_TRANSACTION_ACTION_LIMIT}.`,
    );
  }

  const estimatedBytes = estimateDynamoDBItemSizeBytes(actions.map((action) => action.item));
  if (estimatedBytes > DYNAMODB_TRANSACTION_SIZE_LIMIT_BYTES) {
    throw new DynamoDBTransactionLimitError(
      `DynamoDB transaction is too large: estimated ${estimatedBytes} bytes exceeds ${DYNAMODB_TRANSACTION_SIZE_LIMIT_BYTES} bytes.`,
    );
  }
}

function hasEqualityConditionForLeadingIndexColumn(
  table: AnyTable,
  indexName: string,
  condition: Condition | undefined,
): boolean {
  const leadingColumnName = getLeadingIndexColumnName(table, indexName);
  return (
    leadingColumnName !== undefined && conditionHasLeadingEquality(condition, leadingColumnName)
  );
}

function getLeadingIndexColumnName(table: AnyTable, indexName: string): string | undefined {
  if (indexName === PRIMARY_INDEX_NAME) {
    return table.getIdColumn().name;
  }
  return table.indexes[indexName]?.columnNames[0];
}

function conditionHasLeadingEquality(
  condition: Condition | undefined,
  leadingColumnName: string,
): boolean {
  if (!condition) {
    return false;
  }
  switch (condition.type) {
    case "compare":
      return (
        condition.a.name === leadingColumnName &&
        (condition.operator === "=" || condition.operator === "is")
      );
    case "and":
      return condition.items.some((item) => conditionHasLeadingEquality(item, leadingColumnName));
    case "or":
      return condition.items.every((item) => conditionHasLeadingEquality(item, leadingColumnName));
    case "not":
      return false;
  }
}

function encodeDynamoDBCreateItem(
  values: Record<string, unknown>,
  table: AnyTable,
): Record<string, DynamoDBAttributeValue> {
  const encodedValues = encodeValuesWithDbDefaults(values, table);
  const item: Record<string, DynamoDBAttributeValue> = {};
  for (const [columnName, value] of Object.entries(encodedValues)) {
    const column = table.columns[columnName];
    if (!column) {
      continue;
    }
    const encoded = encodeDynamoDBValue(value, column);
    if (encoded !== undefined) {
      item[columnName] = encoded;
    }
  }
  return item;
}

function findCreatedOutboxReference(
  lookup: OutboxRefLookup,
  reservations: readonly CreateReservation[],
): string | undefined {
  const internalId = String(lookup.internalId);
  const namespace = lookup.namespace ?? null;
  return reservations.find(
    (reservation) =>
      reservation.plan.table === lookup.table &&
      reservation.internalId.toString() === internalId &&
      (reservation.plan.namespace === namespace || lookup.namespace === undefined),
  )?.plan.externalId;
}

function findOutboxLookupLayout(
  lookup: OutboxRefLookup,
  mutationBatch: readonly CompiledMutation<DynamoDBCommandPlan>[],
): DynamoDBTableLayout | undefined {
  for (const mutation of mutationBatch) {
    const operation = mutation.operation;
    if (!operation) {
      continue;
    }
    if ((operation.namespace ?? undefined) !== lookup.namespace) {
      continue;
    }
    if (!Object.values(operation.schema.tables).some((table) => table === lookup.table)) {
      continue;
    }
    return mutation.query.tableLayouts[lookup.table.name];
  }
  return undefined;
}

function createPutIndexActions(
  plan: DynamoDBCreatePlan,
  row: BaseRowItem,
  internalId: bigint,
): TransactionAction[] {
  return createAllIndexItems(plan.table, row, plan.externalId, internalId.toString()).flatMap(
    (item) => createPutIndexItemActions(plan.layout.indexTableName, item),
  );
}

function createChangedSecondaryIndexActions(
  plan: DynamoDBUpdatePlan,
  existingRow: ExistingRow,
  nextRow: ExistingRow,
): TransactionAction[] {
  const actions: TransactionAction[] = [];
  for (const index of Object.values(plan.table.indexes)) {
    if (
      !index.columnNames.some((columnName) =>
        Object.prototype.hasOwnProperty.call(plan.set, columnName),
      )
    ) {
      continue;
    }

    const oldItems = createSecondaryIndexItems(
      index,
      existingRow,
      plan.externalId,
      existingRow._internalId,
    );
    const nextItems = createSecondaryIndexItems(
      index,
      nextRow,
      plan.externalId,
      nextRow._internalId,
    );
    if (oldItems.every((item, index) => indexItemsEqual(item, nextItems[index]))) {
      continue;
    }

    actions.push(
      ...oldItems.map((item) => createDeleteIndexItemAction(plan.layout.indexTableName, item)),
    );
    actions.push(
      ...nextItems.flatMap((item) => createPutIndexItemActions(plan.layout.indexTableName, item)),
    );
  }
  return actions;
}

function createDeleteIndexActions(plan: DynamoDBDeletePlan, row: ExistingRow): TransactionAction[] {
  return createAllIndexItems(plan.table, row, plan.externalId, row._internalId).map((item) =>
    createDeleteIndexItemAction(plan.layout.indexTableName, item),
  );
}

function createAllIndexItems(
  table: AnyTable,
  row: Record<string, unknown>,
  externalId: string,
  internalId: string,
): DynamoDBIndexEntryItem[] {
  return [
    createPrimaryIndexEntry(table, externalId, internalId),
    ...Object.values(table.indexes).flatMap((index) =>
      createSecondaryIndexItems(index, row, externalId, internalId),
    ),
  ];
}

function createSecondaryIndexItems(
  index: AnyTable["indexes"][string],
  row: Record<string, unknown>,
  externalId: string,
  internalId: string,
): DynamoDBIndexEntryItem[] {
  const segments = index.columns.map((column) => ({ column, value: row[column.name] }));
  const hasNullSegment = segments.some(
    (segment) => segment.value === null || segment.value === undefined,
  );
  const entry: DynamoDBIndexEntryItem = {
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
}

function createPrimaryIndexEntry(
  table: AnyTable,
  externalId: string,
  internalId: string,
): DynamoDBIndexEntryItem {
  const sk = createPrimaryIndexSortKey(table, externalId);
  return {
    pk: `idx#${PRIMARY_INDEX_NAME}`,
    sk,
    externalId: decodeDynamoDBIndexEntry(sk).externalId,
    internalId,
  };
}

function createPrimaryIndexSortKey(table: AnyTable, externalId: string): string {
  const idColumn = table.getIdColumn();
  return encodeDynamoDBIndexEntry([{ column: idColumn, value: externalId }], externalId);
}

function createPutIndexItemActions(
  indexTableName: string,
  item: DynamoDBIndexEntryItem,
): TransactionAction[] {
  assertDynamoDBItemSize(item);
  return [
    {
      conditionFailure: "constraint",
      item: {
        Put: {
          TableName: indexTableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        },
      },
    },
  ];
}

function createDeleteIndexItemAction(
  indexTableName: string,
  item: DynamoDBIndexEntryItem,
): TransactionAction {
  return {
    conditionFailure: "constraint",
    item: {
      Delete: {
        TableName: indexTableName,
        Key: { pk: item.pk, sk: item.sk },
      },
    },
  };
}

function indexItemsEqual(
  left: DynamoDBIndexEntryItem,
  right: DynamoDBIndexEntryItem | undefined,
): boolean {
  return right !== undefined && left.pk === right.pk && left.sk === right.sk;
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

function createCursorExclusiveStartKey(
  plan: DynamoDBFindPlan,
): Record<string, unknown> | undefined {
  if (plan.before) {
    throw new Error("DynamoDB before cursor pagination is not implemented yet.");
  }
  if (!plan.after) {
    return undefined;
  }

  const cursor = decodeCursor(plan.after);
  const indexColumns = getIndexColumns(plan.table, plan.indexName);
  const externalId = getCursorExternalId(plan, cursor.indexValues);
  const segments = indexColumns.map((column) => ({
    column,
    value: coerceCursorIndexValue(cursor.indexValues[column.name], column),
  }));

  return {
    pk: `idx#${plan.indexName}`,
    sk: encodeDynamoDBIndexEntry(segments, externalId),
  };
}

function getCursorExternalId(plan: DynamoDBFindPlan, indexValues: Record<string, unknown>): string {
  const tiebreaker = indexValues["__fragnoExternalId"];
  if (typeof tiebreaker === "string") {
    return tiebreaker;
  }
  if (plan.indexName === PRIMARY_INDEX_NAME) {
    const value = indexValues[plan.table.getIdColumn().name];
    if (typeof value === "string") {
      return value;
    }
  }
  throw new Error(
    `DynamoDB cursor for ${plan.tableName}.${plan.indexName} is missing its external ID tiebreaker.`,
  );
}

function getIndexColumns(table: AnyTable, indexName: string): AnyColumn[] {
  if (indexName === PRIMARY_INDEX_NAME) {
    return [table.getIdColumn()];
  }
  const index = table.indexes[indexName];
  if (!index) {
    throw new Error(`Index ${indexName} not found on table ${table.name}.`);
  }
  return [...index.columns];
}

function coerceCursorIndexValue(value: unknown, column: AnyColumn): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (column.type === "date" || column.type === "timestamp") {
    return value instanceof Date ? value : new Date(String(value));
  }
  if (column.role === "internal-id" || column.role === "reference" || column.type === "bigint") {
    return BigInt(String(value));
  }
  return value;
}

function selectDynamoDBQueryTreeRow(
  row: DynamoDBRawRow,
  table: AnyTable,
  selectedColumns: true | readonly string[],
  extraColumnNames: readonly string[] = [],
): DynamoDBRawRow {
  const selected: DynamoDBRawRow = {};
  for (const columnName of getQueryTreeSelectedColumnNames(
    table,
    selectedColumns,
    extraColumnNames,
  )) {
    if (Object.prototype.hasOwnProperty.call(row, columnName)) {
      selected[columnName] = row[columnName];
    }
  }
  return selected;
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

function orderDynamoDBRows(
  rows: DynamoDBRawRow[],
  table: AnyTable,
  orderByIndex: { indexName: string; direction: "asc" | "desc" },
): DynamoDBRawRow[] {
  const columns = getIndexColumns(table, orderByIndex.indexName);
  return rows.slice().sort((left, right) => {
    for (const column of columns) {
      const comparison = compareValues(
        normalizeComparableValue(left[column.name], column),
        normalizeComparableValue(right[column.name], column),
      );
      if (comparison !== 0) {
        return orderByIndex.direction === "asc" ? comparison : -comparison;
      }
    }
    return 0;
  });
}

function evaluateDynamoDBCondition(
  condition: Condition | undefined,
  table: AnyTable,
  row: DynamoDBRawRow,
  parentTable?: AnyTable,
  parentRow?: DynamoDBRawRow,
): boolean {
  if (!condition) {
    return true;
  }
  switch (condition.type) {
    case "and":
      return condition.items.every((item) =>
        evaluateDynamoDBCondition(item, table, row, parentTable, parentRow),
      );
    case "or":
      return condition.items.some((item) =>
        evaluateDynamoDBCondition(item, table, row, parentTable, parentRow),
      );
    case "not":
      return !evaluateDynamoDBCondition(condition.item, table, row, parentTable, parentRow);
    case "compare":
      return evaluateComparison(condition, table, row, parentTable, parentRow);
  }
}

function evaluateComparison(
  condition: Extract<Condition, { type: "compare" }>,
  table: AnyTable,
  row: DynamoDBRawRow,
  parentTable?: AnyTable,
  parentRow?: DynamoDBRawRow,
): boolean {
  const resolved = resolveComparisonSides(condition, table, row, parentTable, parentRow);
  const left = normalizeComparableValue(resolved.leftValue, resolved.leftColumn);
  const operator = condition.operator;

  if (operator === "in" || operator === "not in") {
    const values = Array.isArray(condition.b) ? condition.b : [];
    const matches = values.some(
      (value) =>
        compareValues(
          left,
          normalizeInputComparableValue(
            resolveParentConditionValue(value, resolved.rightColumn, parentTable, parentRow),
            resolved.rightColumn,
          ),
        ) === 0,
    );
    return operator === "in" ? matches : !matches;
  }

  const right = normalizeInputComparableValue(resolved.rightValue, resolved.rightColumn);
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

function resolveComparisonSides(
  condition: Extract<Condition, { type: "compare" }>,
  table: AnyTable,
  row: DynamoDBRawRow,
  parentTable?: AnyTable,
  parentRow?: DynamoDBRawRow,
): {
  leftColumn: AnyColumn;
  leftValue: unknown;
  rightColumn: AnyColumn;
  rightValue: unknown;
} {
  let leftColumn = condition.a;
  let rightColumn = condition.a;

  if (isParentColumnRef(condition.b)) {
    if (!parentTable || !parentRow) {
      throw new Error("Parent column references can only be evaluated for child query-tree nodes.");
    }

    let parentColumn = condition.b.column;
    if (leftColumn.role === "external-id" && parentColumn.role !== "external-id") {
      leftColumn = table.getInternalIdColumn();
    }
    if (parentColumn.role === "external-id" && leftColumn.role !== "external-id") {
      parentColumn = parentTable.getInternalIdColumn();
    }

    return {
      leftColumn,
      leftValue: row[leftColumn.name],
      rightColumn: parentColumn,
      rightValue: parentRow[parentColumn.name],
    };
  }

  return {
    leftColumn,
    leftValue: row[leftColumn.name],
    rightColumn,
    rightValue: condition.b,
  };
}

function resolveParentConditionValue(
  value: unknown,
  fallbackColumn: AnyColumn,
  parentTable?: AnyTable,
  parentRow?: DynamoDBRawRow,
): unknown {
  if (!isParentColumnRef(value)) {
    return value;
  }
  if (!parentTable || !parentRow) {
    throw new Error("Parent column references can only be evaluated for child query-tree nodes.");
  }
  const column =
    value.column.role === "external-id" && fallbackColumn.role !== "external-id"
      ? parentTable.getInternalIdColumn()
      : value.column;
  return parentRow[column.name];
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
