import type { AnyColumn, AnyTable } from "../schema/create";
import { buildCondition, type Condition } from "./condition-builder";
import type { AnySelectClause, FindManyOptions, OrderBy } from "./mod";

function isOrderByArray(v: OrderBy | OrderBy[]): v is OrderBy[] {
  return Array.isArray(v) && Array.isArray(v[0]);
}

function simplifyOrderBy(
  columns: Record<string, AnyColumn>,
  orderBy: OrderBy | OrderBy[] | undefined,
): OrderBy<AnyColumn>[] | undefined {
  if (!orderBy || orderBy.length === 0) {
    return undefined;
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
  { select = true, where, orderBy, ...options }: FindManyOptions,
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
    ...options,
  };
}

export type SimplifyFindOptions<O> = Omit<O, "where" | "orderBy" | "select"> & {
  select: AnySelectClause;
  where?: Condition | undefined;
  orderBy?: OrderBy<AnyColumn>[];
};
