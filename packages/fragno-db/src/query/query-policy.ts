import type { AnySchema, AnyTable } from "../schema/create";
import type { Condition } from "./condition-builder";
import { createIndexedBuilder } from "./condition-builder";
import type { MutationOperation } from "./unit-of-work/mutation-recorder";
import type {
  CompiledQueryTreeChildNode,
  CompiledQueryTreeRootNode,
} from "./unit-of-work/query-tree";
import type { IndexedConditionBuilder, RetrievalOperation } from "./unit-of-work/unit-of-work";

export type QueryPolicyController<TSchema extends AnySchema> = {
  addRead<TTableName extends keyof TSchema["tables"] & string>(
    tableName: TTableName,
    build: (builder: IndexedConditionBuilder<TSchema["tables"][TTableName]>) => Condition | boolean,
  ): void;
  /** Scope every database operation in the request to one row shard. */
  setRowShard(shard: string): void;
};

type ReadQueryPolicy = {
  schema: AnySchema;
  namespace: string | null;
  tableName: string;
  condition: Condition;
};

type ReadPoliciesByTable = Map<string, Condition[]>;
type ReadPoliciesByNamespace = Map<string | null, ReadPoliciesByTable>;

/** Request-scoped predicates applied before database operations reach an adapter. */
export class QueryPolicySet {
  readonly #readPolicies = new WeakMap<AnySchema, ReadPoliciesByNamespace>();
  #rowShard: string | null = null;
  #frozen = false;

  freeze(): void {
    this.#frozen = true;
  }

  setRowShard(shard: string): void {
    if (this.#frozen) {
      throw new Error("Query policies cannot change after a database operation is recorded.");
    }
    if (shard.length === 0) {
      throw new Error("Row shard must be a non-empty string.");
    }
    if (this.#rowShard !== null && this.#rowShard !== shard) {
      throw new Error(
        `Database shard scope conflict: the request is already scoped to "${this.#rowShard}".`,
      );
    }
    this.#rowShard = shard;
  }

  getRowShard(): string | null {
    return this.#rowShard;
  }

  addRead(policy: ReadQueryPolicy): void {
    if (this.#frozen) {
      throw new Error("Query policies cannot change after a database operation is recorded.");
    }
    let byNamespace = this.#readPolicies.get(policy.schema);
    if (!byNamespace) {
      byNamespace = new Map();
      this.#readPolicies.set(policy.schema, byNamespace);
    }

    let byTable = byNamespace.get(policy.namespace);
    if (!byTable) {
      byTable = new Map();
      byNamespace.set(policy.namespace, byTable);
    }

    const tablePolicies = byTable.get(policy.tableName) ?? [];
    tablePolicies.push(policy.condition);
    byTable.set(policy.tableName, tablePolicies);
  }

  getRead(
    schema: AnySchema,
    namespace: string | null | undefined,
    tableName: string,
  ): readonly Condition[] {
    const configured =
      this.#readPolicies
        .get(schema)
        ?.get(namespace ?? null)
        ?.get(tableName) ?? [];
    if (this.#rowShard === null) {
      return configured;
    }

    const table = schema.tables[tableName];
    const shardColumn = table?.columns["_shard"];
    if (!table || !shardColumn) {
      throw new Error(`Table ${tableName} does not define the required _shard column.`);
    }

    return [
      ...configured,
      {
        type: "compare",
        a: shardColumn,
        operator: "=",
        b: this.#rowShard,
      },
    ];
  }
}

function buildReadPolicyCondition<TTable extends AnyTable>(
  table: TTable,
  build: (builder: IndexedConditionBuilder<TTable>) => Condition | boolean,
): Condition | boolean {
  const indexedColumnNames = new Set<string>();
  for (const index of Object.values(table.indexes)) {
    for (const column of index.columns) {
      indexedColumnNames.add(column.name);
    }
  }

  return build(
    createIndexedBuilder(table.columns, indexedColumnNames) as IndexedConditionBuilder<TTable>,
  );
}

export function createQueryPolicyController<TSchema extends AnySchema>(
  schema: TSchema,
  namespace: string | null,
  getPolicySet: () => QueryPolicySet,
): QueryPolicyController<TSchema> {
  return {
    addRead<TTableName extends keyof TSchema["tables"] & string>(
      tableName: TTableName,
      build: (
        builder: IndexedConditionBuilder<TSchema["tables"][TTableName]>,
      ) => Condition | boolean,
    ) {
      const table = schema.tables[tableName] as TSchema["tables"][TTableName] | undefined;
      if (!table) {
        throw new Error(`Table ${tableName} not found in schema`);
      }

      const condition = buildReadPolicyCondition(table, build);
      if (condition === true) {
        return;
      }
      if (condition === false) {
        throw new Error(
          `Read query policy for table "${tableName}" cannot compile to false. ` +
            "Reject the request in middleware instead.",
        );
      }

      getPolicySet().addRead({
        schema,
        namespace,
        tableName,
        condition,
      });
    },
    setRowShard(shard: string) {
      getPolicySet().setRowShard(shard);
    },
  };
}

function combineConditions(
  existing: Condition | undefined,
  policies: readonly Condition[],
): Condition | undefined {
  if (policies.length === 0) {
    return existing;
  }
  if (!existing && policies.length === 1) {
    return policies[0];
  }

  return {
    type: "and",
    items: existing ? [existing, ...policies] : [...policies],
  };
}

function applyChildReadQueryPolicies(
  child: CompiledQueryTreeChildNode,
  inheritedSchema: AnySchema,
  inheritedNamespace: string | null | undefined,
  policies: QueryPolicySet,
): CompiledQueryTreeChildNode {
  const schema = child.schema ?? inheritedSchema;
  const namespace = child.schema ? (child.namespace ?? null) : inheritedNamespace;
  const readPolicies = policies.getRead(schema, namespace, child.table.name);
  const children = child.children.map((nestedChild) =>
    applyChildReadQueryPolicies(nestedChild, schema, namespace, policies),
  );

  if (
    readPolicies.length === 0 &&
    children.every((nested, index) => nested === child.children[index])
  ) {
    return child;
  }

  return {
    ...child,
    where: combineConditions(child.where, readPolicies),
    children,
  };
}

function applyRootReadQueryPolicies(
  root: CompiledQueryTreeRootNode,
  schema: AnySchema,
  namespace: string | null | undefined,
  policies: QueryPolicySet,
): CompiledQueryTreeRootNode {
  const readPolicies = policies.getRead(schema, namespace, root.table.name);
  const children = root.children.map((child) =>
    applyChildReadQueryPolicies(child, schema, namespace, policies),
  );

  if (
    readPolicies.length === 0 &&
    children.every((child, index) => child === root.children[index])
  ) {
    return root;
  }

  return {
    ...root,
    where: combineConditions(root.where, readPolicies),
    children,
  };
}

export function applyWriteQueryPolicies(
  operation: MutationOperation<AnySchema>,
  policies: QueryPolicySet,
): MutationOperation<AnySchema> {
  const shard = policies.getRowShard();
  if (shard === null) {
    return operation;
  }
  if (operation.shard !== null && operation.shard !== shard) {
    throw new Error(
      `Database shard scope conflict: mutation is scoped to "${operation.shard}" instead of "${shard}".`,
    );
  }

  if (operation.type !== "create") {
    if (
      operation.type === "update" &&
      Object.prototype.hasOwnProperty.call(operation.set, "_shard")
    ) {
      throw new Error("Update mutation cannot change the active row shard.");
    }
    return { ...operation, shard };
  }

  const providedShard = (operation.values as Record<string, unknown>)["_shard"];
  if (providedShard !== undefined && providedShard !== shard) {
    throw new Error(`Create mutation cannot override the active row shard "${shard}".`);
  }

  return {
    ...operation,
    shard,
    values: {
      ...operation.values,
      _shard: shard,
    },
  };
}

export function applyReadQueryPolicies(
  operation: RetrievalOperation<AnySchema>,
  policies: QueryPolicySet,
): RetrievalOperation<AnySchema> {
  const readPolicies = policies.getRead(
    operation.schema,
    operation.namespace,
    operation.table.name,
  );

  if (operation.type === "find" && operation.options.queryTree) {
    const queryTree = applyRootReadQueryPolicies(
      operation.options.queryTree,
      operation.schema,
      operation.namespace,
      policies,
    );

    return queryTree === operation.options.queryTree
      ? operation
      : {
          ...operation,
          options: {
            ...operation.options,
            queryTree,
          },
        };
  }

  if (readPolicies.length === 0) {
    return operation;
  }

  const existingWhere = operation.options.where;
  return {
    ...operation,
    options: {
      ...operation.options,
      where: (builder) =>
        builder.and(existingWhere ? existingWhere(builder) : true, ...readPolicies),
    },
  };
}
