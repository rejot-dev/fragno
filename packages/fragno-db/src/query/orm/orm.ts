import type {
  AnySelectClause,
  FindFirstOptions,
  FindManyOptions,
  JoinBuilder,
  OrderBy,
} from "../query";
import { buildCondition, type Condition, type ConditionBuilder } from "../condition-builder";
import type { AnyColumn, AnyRelation, AnyTable, Index } from "../../schema/create";

export interface CompiledJoin {
  relation: AnyRelation;
  options: SimplifyFindOptions<FindManyOptions> | false;
}

function isOrderByArray(v: OrderBy | OrderBy[]): v is OrderBy[] {
  return Array.isArray(v) && Array.isArray(v[0]);
}

function simplifyOrderBy(
  columns: Record<string, AnyColumn>,
  orderBy: OrderBy | OrderBy[] | undefined,
): OrderBy<AnyColumn>[] | undefined {
  if (!orderBy || orderBy.length === 0) {
    return;
  }

  if (!isOrderByArray(orderBy)) {
    orderBy = [orderBy];
  }
  return orderBy.map(([name, value]) => {
    const col = columns[name];
    if (!col) {
      throw new Error(`unknown column name ${name}.`);
    }

    return [col, value];
  });
}

export function buildFindOptions(
  table: AnyTable,
  { select = true, where, orderBy, join, ...options }: FindManyOptions,
): SimplifyFindOptions<FindManyOptions> | false {
  let conditions = where ? buildCondition(table.columns, where) : undefined;
  if (conditions === true) {
    conditions = undefined;
  }
  if (conditions === false) {
    return false;
  }

  return {
    select,
    where: conditions,
    orderBy: simplifyOrderBy(table.columns, orderBy),
    join: join ? buildJoin(table, join) : undefined,
    ...options,
  };
}

function buildJoin<TTable extends AnyTable>(
  table: AnyTable,
  fn: (builder: JoinBuilder<TTable>) => void,
): CompiledJoin[] {
  const compiled: CompiledJoin[] = [];
  const builder: Record<string, unknown> = {};

  for (const name in table.relations) {
    const relation = table.relations[name]!;

    builder[name] = (options: FindFirstOptions | FindManyOptions = {}) => {
      compiled.push({
        relation,
        options: buildFindOptions(relation.table, options),
      });

      delete builder[name];
      return builder;
    };
  }

  fn(builder as JoinBuilder<TTable>);
  return compiled;
}

export type SimplifyFindOptions<O> = Omit<O, "where" | "orderBy" | "select" | "join"> & {
  select: AnySelectClause;
  where?: Condition | undefined;
  orderBy?: OrderBy<AnyColumn>[];
  join?: CompiledJoin[];
};

/**
 * Extract column names from a single index
 */
type IndexColumns<TIndex extends Index> = TIndex["columns"][number]["ormName"];

/**
 * Extract all indexed column names from a table's indexes
 */
type IndexedColumns<TIndexes extends Record<string, Index>> = TIndexes[keyof TIndexes] extends Index
  ? IndexColumns<TIndexes[keyof TIndexes]>
  : never;

/**
 * ConditionBuilder restricted to indexed columns only.
 */
type IndexedConditionBuilder<TTable extends AnyTable> = ConditionBuilder<
  Pick<TTable["columns"], IndexedColumns<TTable["indexes"]>>
>;

/**
 * Join options with where clause restricted to indexed columns
 */
type IndexedJoinOptions<TTable extends AnyTable> = {
  select?: (keyof TTable["columns"])[];
  where?: (eb: IndexedConditionBuilder<TTable>) => Condition | boolean;
};

/**
 * Join builder with indexed-only where clauses for Unit of Work
 */
export type IndexedJoinBuilder<TTable extends AnyTable> = {
  [K in keyof TTable["relations"]]: TTable["relations"][K] extends AnyRelation
    ? (options?: IndexedJoinOptions<TTable["relations"][K]["table"]>) => void
    : never;
};

/**
 * Build join operations with indexed-only where clauses for Unit of Work
 * This ensures all join conditions can leverage indexes for optimal performance
 */
export function buildJoinIndexed<TTable extends AnyTable>(
  table: TTable,
  fn: (builder: IndexedJoinBuilder<TTable>) => void,
): CompiledJoin[] {
  const compiled: CompiledJoin[] = [];
  const builder: Record<string, unknown> = {};

  for (const name in table.relations) {
    const relation = table.relations[name]!;

    builder[name] = (options: IndexedJoinOptions<AnyTable> = {}) => {
      const { select = true, where, ...rest } = options;

      // Build condition with indexed columns only
      let conditions = where ? buildCondition(relation.table.columns, where) : undefined;
      if (conditions === true) {
        conditions = undefined;
      }

      // If condition evaluates to false, skip this join
      if (conditions === false) {
        compiled.push({
          relation,
          options: false,
        });
      } else {
        compiled.push({
          relation,
          options: {
            select,
            where: conditions,
            orderBy: undefined,
            join: undefined,
            ...rest,
          },
        });
      }

      delete builder[name];
      return builder;
    };
  }

  fn(builder as IndexedJoinBuilder<TTable>);
  return compiled;
}
