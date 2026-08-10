import type { CompiledQuery, RawBuilder, SelectQueryBuilder, Kysely } from "kysely";
import { sql } from "kysely";

import type { NamingResolver } from "../../../naming/sql-naming";
import type { Condition } from "../../../query/condition-builder";
import type {
  CompiledQueryTreeChildNode,
  CompiledQueryTreeRootNode,
  QueryTreeOrderBy,
} from "../../../query/unit-of-work/query-tree";
import { getQueryTreeSelectedColumnNames } from "../../../query/unit-of-work/query-tree";
import type { AnyColumn, AnyTable } from "../../../schema/create";
import type { DriverConfig } from "../driver-config";
import type { SQLiteStorageMode } from "../sqlite-storage";
import { buildCursorCondition } from "./cursor-utils";
import { buildQueryTreeWhere } from "./query-tree-where-builder";
import { projectJsonSelectedColumnValue, projectSelectedColumn } from "./select-builder";
import { buildWhere } from "./where-builder";

// oxlint-disable-next-line no-explicit-any
type AnyKysely = Kysely<any>;
// oxlint-disable-next-line no-explicit-any
type AnySelectQueryBuilder<O = any> = SelectQueryBuilder<any, any, O>;

const CHILD_JSON_COLUMN_ALIAS = "_fragno_item";

export class QueryTreeSQLCompiler {
  readonly #db: AnyKysely;
  readonly #driverConfig: DriverConfig;
  readonly #sqliteStorageMode?: SQLiteStorageMode;
  readonly #resolver?: NamingResolver;

  constructor(
    db: AnyKysely,
    driverConfig: DriverConfig,
    sqliteStorageMode?: SQLiteStorageMode,
    resolver?: NamingResolver,
  ) {
    this.#db = db;
    this.#driverConfig = driverConfig;
    this.#sqliteStorageMode = sqliteStorageMode;
    this.#resolver = resolver;
  }

  compile(
    root: CompiledQueryTreeRootNode,
    options?: { readTracking?: boolean; withCursor?: boolean },
  ): CompiledQuery {
    const readTracking = options?.readTracking ?? false;
    const orderByIndex =
      root.orderByIndex ??
      (root.after || root.before
        ? { indexName: root.useIndex, direction: "asc" as const }
        : undefined);
    const cursorColumns = orderByIndex
      ? this.#resolveOrderByColumns(root.table, orderByIndex.indexName)
      : [];
    const cursorCondition = buildCursorCondition(
      root.after || root.before,
      cursorColumns,
      orderByIndex?.direction ?? "asc",
      !!root.after,
      this.#driverConfig,
      this.#sqliteStorageMode,
    );
    const combinedWhere = this.#combineConditions(root.where, cursorCondition);

    const rootAlias = "_fragno_root";
    let query = this.#db.selectFrom(
      `${this.#getTableName(root.table, this.#resolver)} as ${rootAlias}`,
    );

    if (combinedWhere) {
      query = query.where((eb) =>
        buildWhere(
          combinedWhere,
          eb,
          this.#driverConfig,
          this.#sqliteStorageMode,
          this.#resolver,
          root.table,
          rootAlias,
        ),
      );
    }

    query = this.#applyOrderByIndex(query, root.table, orderByIndex, rootAlias);

    const effectivePageSize =
      options?.withCursor && root.pageSize !== undefined ? root.pageSize + 1 : root.pageSize;
    if (effectivePageSize !== undefined) {
      query = query.limit(effectivePageSize);
    }

    const selectedColumnNames = getQueryTreeSelectedColumnNames(
      root.table,
      root.select,
      readTracking ? [root.table.getIdColumn().name] : [],
    );

    const selections = selectedColumnNames.map((columnName) => {
      const column = root.table.columns[columnName];
      const physicalName = this.#getColumnName(root.table, column.name, this.#resolver);
      return projectSelectedColumn(
        {
          column,
          reference: `${rootAlias}.${physicalName}`,
          alias: columnName,
        },
        this.#driverConfig,
      );
    });

    for (const child of root.children) {
      selections.push(
        this.#buildChildExpression(
          child,
          root.table,
          rootAlias,
          child.alias,
          0,
          readTracking,
          this.#resolver,
        ),
      );
    }

    return query.select(selections).compile();
  }

  #buildChildExpression(
    child: CompiledQueryTreeChildNode,
    parentTable: AnyTable,
    parentAlias: string,
    path: string,
    depth: number,
    readTracking: boolean,
    parentResolver?: NamingResolver,
  ) {
    return this.#buildChildValueExpression(
      child,
      parentTable,
      parentAlias,
      path,
      depth,
      readTracking,
      parentResolver,
    ).as(child.alias);
  }

  #buildChildValueExpression(
    child: CompiledQueryTreeChildNode,
    parentTable: AnyTable,
    parentAlias: string,
    path: string,
    depth: number,
    readTracking: boolean,
    parentResolver?: NamingResolver,
  ) {
    const childResolver = this.#getNodeResolver(child);
    const childAlias = `_fragno_${path.replace(/[^a-zA-Z0-9_]/g, "_")}_${depth}`;
    const jsonObject = this.#buildJsonObjectExpression(
      child,
      childAlias,
      path,
      depth,
      readTracking,
      childResolver,
    );
    let projectedItem = jsonObject;
    if (
      this.#driverConfig.databaseType === "mysql" &&
      child.cardinality === "many" &&
      child.orderByIndex
    ) {
      projectedItem = this.#projectMySQLOrderedJoinManyItem(
        jsonObject,
        child.table,
        child.orderByIndex,
        childAlias,
        childResolver,
      );
    }

    let childQuery = this.#db
      .selectFrom(
        `${child.schema ? this.#getQualifiedTableName(child.table, childResolver) : this.#getTableName(child.table, childResolver)} as ${childAlias}`,
      )
      .select(projectedItem.as(CHILD_JSON_COLUMN_ALIAS));

    const onIndex = child.onIndex;
    if (onIndex) {
      childQuery = childQuery.where((eb) =>
        buildQueryTreeWhere(
          onIndex,
          eb,
          this.#driverConfig,
          this.#sqliteStorageMode,
          childResolver,
          child.table,
          childAlias,
          parentTable,
          parentAlias,
          parentResolver,
        ),
      );
    }

    const childWhere = child.where;
    if (childWhere) {
      childQuery = childQuery.where((eb) =>
        buildWhere(
          childWhere,
          eb,
          this.#driverConfig,
          this.#sqliteStorageMode,
          childResolver,
          child.table,
          childAlias,
        ),
      );
    }

    childQuery = this.#applyOrderByIndex(
      childQuery,
      child.table,
      child.orderByIndex,
      childAlias,
      childResolver,
    );

    if (child.pageSize !== undefined) {
      childQuery = childQuery.limit(child.pageSize);
    }

    if (child.cardinality === "one") {
      return sql`(${childQuery.limit(1)})`;
    }

    return this.#wrapJsonArrayAggValue(childQuery);
  }

  #projectMySQLOrderedJoinManyItem(
    jsonObject: RawBuilder<unknown>,
    childTable: AnyTable,
    orderByIndex: QueryTreeOrderBy,
    childAlias: string,
    resolver?: NamingResolver,
  ): RawBuilder<unknown> {
    const orderExpressions = this.#resolveOrderByColumns(childTable, orderByIndex.indexName).map(
      (column) => {
        const reference = sql.ref(
          `${childAlias}.${this.#getColumnName(childTable, column.name, resolver)}`,
        );
        return orderByIndex.direction === "desc" ? sql`${reference} desc` : sql`${reference} asc`;
      },
    );

    // JSON_ARRAYAGG can discard the child query order. The ordinal lets the decoder restore the
    // database-defined order without requiring ordering columns in the public child projection.
    return sql`json_array(row_number() over (order by ${sql.join(orderExpressions)}), ${jsonObject})`;
  }

  #buildJsonObjectExpression(
    node: CompiledQueryTreeRootNode | CompiledQueryTreeChildNode,
    rowAlias: string,
    path: string,
    depth: number,
    readTracking: boolean,
    resolver?: NamingResolver,
  ) {
    const items: Array<{ key: string; expr: unknown }> = [];

    for (const columnName of getQueryTreeSelectedColumnNames(
      node.table,
      node.select,
      readTracking ? [node.table.getIdColumn().name] : [],
    )) {
      const column = node.table.columns[columnName];
      const physicalName = this.#getColumnName(node.table, column.name, resolver);
      items.push({
        key: columnName,
        expr: projectJsonSelectedColumnValue(
          column,
          `${rowAlias}.${physicalName}`,
          this.#driverConfig,
          this.#sqliteStorageMode,
        ),
      });
    }

    for (const child of node.children) {
      const childValueExpr = this.#buildChildValueExpression(
        child,
        node.table,
        rowAlias,
        `${path}_${child.alias}`,
        depth + 1,
        readTracking,
        resolver,
      );
      items.push({
        key: child.alias,
        expr:
          this.#driverConfig.databaseType === "sqlite"
            ? sql`json(${childValueExpr})`
            : childValueExpr,
      });
    }

    return this.#jsonObject(items);
  }

  #jsonObject(items: Array<{ key: string; expr: unknown }>) {
    const args: unknown[] = [];
    for (const item of items) {
      args.push(sql.lit(item.key));
      args.push(item.expr);
    }

    switch (this.#driverConfig.databaseType) {
      case "sqlite":
      case "mysql":
        return sql`json_object(${sql.join(args)})`;
      case "postgresql":
        return sql`json_build_object(${sql.join(args)})`;
      default:
        throw new Error("Unsupported database type.");
    }
  }

  #wrapJsonArrayAggValue(query: AnySelectQueryBuilder) {
    switch (this.#driverConfig.databaseType) {
      case "sqlite":
        return sql`
          coalesce(
            (
              select json_group_array(json(${sql.ref(`_fragno_agg.${CHILD_JSON_COLUMN_ALIAS}`)}))
              from (${query}) as _fragno_agg
            ),
            json('[]')
          )
        `;
      case "postgresql":
        return sql`
          coalesce(
            (
              select json_agg(${sql.ref(`_fragno_agg.${CHILD_JSON_COLUMN_ALIAS}`)})
              from (${query}) as _fragno_agg
            ),
            '[]'::json
          )
        `;
      case "mysql":
        return sql`
          coalesce(
            (
              select json_arrayagg(${sql.ref(`_fragno_agg.${CHILD_JSON_COLUMN_ALIAS}`)})
              from (${query}) as _fragno_agg
            ),
            json_array()
          )
        `;
      default:
        throw new Error("Unsupported database type.");
    }
  }

  #combineConditions(left: Condition | undefined, right: Condition | undefined) {
    if (left && right) {
      return {
        type: "and" as const,
        items: [left, right],
      };
    }

    return left ?? right;
  }

  #applyOrderByIndex<T extends { orderBy(column: string, direction: "asc" | "desc"): T }>(
    query: T,
    table: AnyTable,
    orderByIndex: { indexName: string; direction: "asc" | "desc" } | undefined,
    alias: string,
    resolver: NamingResolver | undefined = this.#resolver,
  ): T {
    if (!orderByIndex) {
      return query;
    }

    let orderedQuery = query;
    for (const column of this.#resolveOrderByColumns(table, orderByIndex.indexName)) {
      orderedQuery = orderedQuery.orderBy(
        `${alias}.${this.#getColumnName(table, column.name, resolver)}`,
        orderByIndex.direction,
      );
    }

    return orderedQuery;
  }

  #resolveOrderByColumns(table: AnyTable, indexName: string): AnyColumn[] {
    if (indexName === "_primary") {
      return [table.getIdColumn()];
    }

    const index = table.indexes[indexName];
    if (!index) {
      throw new Error(`Index "${indexName}" not found on table "${table.name}".`);
    }

    return index.columns;
  }

  #getNodeResolver(node: CompiledQueryTreeChildNode): NamingResolver | undefined {
    if (!node.schema) {
      return this.#resolver;
    }
    return this.#resolver?.forSchema(node.schema, node.namespace ?? null);
  }

  #getTableName(table: AnyTable, resolver?: NamingResolver): string {
    return resolver ? resolver.getTableName(table.name) : table.name;
  }

  #getQualifiedTableName(table: AnyTable, resolver?: NamingResolver): string {
    const tableName = this.#getTableName(table, resolver);
    const schemaName = resolver?.getSchemaName();
    if (schemaName) {
      return `${schemaName}.${tableName}`;
    }
    return this.#driverConfig.databaseType === "postgresql" ? `public.${tableName}` : tableName;
  }

  #getColumnName(table: AnyTable, columnName: string, resolver?: NamingResolver): string {
    return resolver ? resolver.getColumnName(table.name, columnName) : columnName;
  }
}
