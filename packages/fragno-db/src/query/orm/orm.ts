import type {
  AnySelectClause,
  FindFirstOptions,
  FindManyOptions,
  JoinBuilder,
  OrderBy,
} from "../simple-query-interface";
import { buildCondition, type Condition } from "../condition-builder";
import type { AnyColumn, AnyRelation, AnyTable } from "../../schema/create";

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
