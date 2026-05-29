import {
  buildCondition,
  type Condition,
  type ConditionBuilder,
} from "../../query/condition-builder";
import type {
  CompiledMutation,
  MutationOperation,
  RetrievalOperation,
} from "../../query/unit-of-work/unit-of-work";
import { encodeValues, encodeValuesWithDbDefaults } from "../../query/value-encoding";
import type { AnyColumn, AnySchema, AnyTable } from "../../schema/create";
import { SQLocalDriverConfig } from "../generic-sql/driver-config";
import { UOWOperationCompiler } from "../shared/uow-operation-compiler";
import { createDynamoDBLayout, type DynamoDBTableLayout } from "./dynamodb-layout";
import { encodeDynamoDBItemAttributes, type DynamoDBAttributeValue } from "./dynamodb-value-codec";

export type DynamoDBCommandPlan =
  | DynamoDBFindPlan
  | DynamoDBCountPlan
  | DynamoDBCreatePlan
  | DynamoDBUpdatePlan
  | DynamoDBDeletePlan
  | DynamoDBCheckPlan;

export interface DynamoDBPlanBase {
  kind: "find" | "count" | "create" | "update" | "delete" | "check";
  schemaName: string;
  namespace: string;
  tableName: string;
  layout: DynamoDBTableLayout;
}

export interface DynamoDBFindPlan extends DynamoDBPlanBase {
  kind: "find";
  indexName: string;
  selectedColumns: string[] | true;
  condition?: Condition;
  orderDirection: "asc" | "desc";
  pageSize?: number;
  after?: string;
  before?: string;
  withCursor: boolean;
  withSingleResult: boolean;
  readTracking: boolean;
}

export interface DynamoDBCountPlan extends DynamoDBPlanBase {
  kind: "count";
  indexName: string;
  condition?: Condition;
}

export interface DynamoDBCreatePlan extends DynamoDBPlanBase {
  kind: "create";
  externalId: string;
  item: Record<string, DynamoDBAttributeValue>;
}

export interface DynamoDBUpdatePlan extends DynamoDBPlanBase {
  kind: "update";
  externalId: string;
  expectedVersion?: number;
  set: Record<string, DynamoDBAttributeValue>;
}

export interface DynamoDBDeletePlan extends DynamoDBPlanBase {
  kind: "delete";
  externalId: string;
  expectedVersion?: number;
}

export interface DynamoDBCheckPlan extends DynamoDBPlanBase {
  kind: "check";
  externalId: string;
  expectedVersion: number;
}

export interface DynamoDBOperationCompilerOptions {
  tablePrefix?: string;
}

function normalizeSelectedColumns(select: true | readonly string[] | undefined): true | string[] {
  if (select === undefined || select === true) {
    return true;
  }
  return [...select];
}

export class DynamoDBUOWOperationCompiler extends UOWOperationCompiler<DynamoDBCommandPlan> {
  readonly #tablePrefix?: string;

  constructor(options: DynamoDBOperationCompilerOptions = {}) {
    super(new SQLocalDriverConfig());
    this.#tablePrefix = options.tablePrefix;
  }

  override compileCount(
    op: RetrievalOperation<AnySchema> & { type: "count" },
  ): DynamoDBCommandPlan | null {
    const condition = this.#compileCondition(op.table, op.options.where);
    if (condition === false) {
      return null;
    }
    return {
      ...this.#basePlan(op.schema, op.namespace, op.table),
      kind: "count",
      indexName: op.indexName,
      condition,
    };
  }

  override compileFind(
    op: RetrievalOperation<AnySchema> & { type: "find" },
  ): DynamoDBCommandPlan | null {
    const condition = this.#compileCondition(op.table, op.options.where);
    if (condition === false) {
      return null;
    }

    return {
      ...this.#basePlan(op.schema, op.namespace, op.table),
      kind: "find",
      indexName: op.indexName,
      selectedColumns: normalizeSelectedColumns(op.options.select),
      condition,
      orderDirection: op.options.orderByIndex?.direction ?? "asc",
      pageSize: op.options.pageSize,
      after: typeof op.options.after === "string" ? op.options.after : op.options.after?.encode(),
      before:
        typeof op.options.before === "string" ? op.options.before : op.options.before?.encode(),
      withCursor: op.withCursor ?? false,
      withSingleResult: op.withSingleResult ?? false,
      readTracking: op.readTracking ?? false,
    };
  }

  override compileCreate(
    op: MutationOperation<AnySchema> & { type: "create" },
  ): CompiledMutation<DynamoDBCommandPlan> | null {
    const table = this.getTable(op.schema, op.table);
    const values = encodeValuesWithDbDefaults(op.values, table);
    const item = encodeDynamoDBItemAttributes(values, table);

    return {
      query: {
        ...this.#basePlan(op.schema, op.namespace, table),
        kind: "create",
        externalId: op.generatedExternalId,
        item,
      },
      operation: op,
      op: "create",
      expectedAffectedRows: null,
      expectedReturnedRows: null,
    };
  }

  override compileUpdate(
    op: MutationOperation<AnySchema> & { type: "update" },
  ): CompiledMutation<DynamoDBCommandPlan> | null {
    const table = this.getTable(op.schema, op.table);
    const values = encodeValues(op.set, table, false);
    const set = encodeDynamoDBItemAttributes(values, table);

    return {
      query: {
        ...this.#basePlan(op.schema, op.namespace, table),
        kind: "update",
        externalId: this.getExternalId(op.id),
        expectedVersion: this.getVersionToCheck(op.id, op.checkVersion),
        set,
      },
      operation: op,
      op: "update",
      expectedAffectedRows: op.checkVersion ? 1n : null,
      expectedReturnedRows: null,
    };
  }

  override compileDelete(
    op: MutationOperation<AnySchema> & { type: "delete" },
  ): CompiledMutation<DynamoDBCommandPlan> | null {
    const table = this.getTable(op.schema, op.table);
    return {
      query: {
        ...this.#basePlan(op.schema, op.namespace, table),
        kind: "delete",
        externalId: this.getExternalId(op.id),
        expectedVersion: this.getVersionToCheck(op.id, op.checkVersion),
      },
      operation: op,
      op: "delete",
      expectedAffectedRows: op.checkVersion ? 1n : null,
      expectedReturnedRows: null,
    };
  }

  override compileCheck(
    op: MutationOperation<AnySchema> & { type: "check" },
  ): CompiledMutation<DynamoDBCommandPlan> | null {
    const table = this.getTable(op.schema, op.table);
    return {
      query: {
        ...this.#basePlan(op.schema, op.namespace, table),
        kind: "check",
        externalId: op.id.externalId,
        expectedVersion: op.id.version,
      },
      operation: op,
      op: "check",
      expectedAffectedRows: null,
      expectedReturnedRows: 1,
    };
  }

  #basePlan(
    schema: AnySchema,
    namespace: string | null | undefined,
    table: AnyTable,
  ): DynamoDBPlanBase {
    const layout = createDynamoDBLayout({
      schema,
      namespace: namespace ?? null,
      tablePrefix: this.#tablePrefix,
    });
    return {
      kind: "find",
      schemaName: schema.name,
      namespace: layout.namespace,
      tableName: table.name,
      layout: layout.getTableLayout(table),
    };
  }

  #compileCondition(
    table: AnyTable,
    where: ((builder: never) => Condition | boolean) | undefined,
  ): Condition | undefined | false {
    if (!where) {
      return undefined;
    }
    const condition = buildCondition(
      table.columns,
      where as (builder: ConditionBuilder<Record<string, AnyColumn>>) => Condition | boolean,
    );
    if (condition === true) {
      return undefined;
    }
    if (condition === false) {
      return false;
    }
    return condition;
  }
}
