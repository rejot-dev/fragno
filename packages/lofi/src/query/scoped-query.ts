import type { AnySchema, AnyTable } from "@fragno-dev/db/schema";
import type { FindBuilder } from "@fragno-dev/db/unit-of-work";
import type { LofiQueryInterface } from "../types";
import type { Condition, ConditionBuilder } from "./conditions";

type ScopedIndexName<TTable extends AnyTable> = "primary" | (string & keyof TTable["indexes"]);

export type LofiQueryScopeResult<TTable extends AnyTable> = {
  indexName: ScopedIndexName<TTable>;
  where: (eb: ConditionBuilder<TTable["columns"]>) => Condition | boolean;
};

export type LofiQueryScope<TSchema extends AnySchema, TContext> = <
  TableName extends keyof TSchema["tables"] & string,
>(options: {
  tableName: TableName;
  context: TContext;
}) => LofiQueryScopeResult<TSchema["tables"][TableName]> | undefined;

type ScopedQueryOptions<TSchema extends AnySchema, TContext> = {
  query: LofiQueryInterface<TSchema>;
  context: TContext;
  scope?: LofiQueryScope<TSchema, TContext>;
};

const combineWhere = <TTable extends AnyTable>(options: {
  base?: (eb: ConditionBuilder<TTable["columns"]>) => Condition | boolean;
  scope?: (eb: ConditionBuilder<TTable["columns"]>) => Condition | boolean;
}) => {
  const { base, scope } = options;
  if (base && scope) {
    return (eb: ConditionBuilder<TTable["columns"]>) => eb.and(base(eb), scope(eb));
  }
  return base ?? scope;
};

const wrapBuilderFn = <TTable extends AnyTable>(options: {
  tableName: string;
  builderFn?: (builder: FindBuilder<TTable>) => unknown;
  scopeResult: LofiQueryScopeResult<TTable>;
}) => {
  const { tableName, builderFn, scopeResult } = options;

  return (builder: FindBuilder<TTable>) => {
    let userIndex: string | undefined;
    let userWhere: ((eb: ConditionBuilder<TTable["columns"]>) => Condition | boolean) | undefined;

    const wrapper = new Proxy(builder, {
      get(target, prop, receiver) {
        const value = (target as Record<string, unknown>)[prop as string];
        if (prop === "whereIndex") {
          return (
            indexName: string,
            condition?: (eb: ConditionBuilder<TTable["columns"]>) => Condition | boolean,
          ) => {
            userIndex = indexName;
            userWhere = condition;
            return receiver;
          };
        }
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            const result = (value as (...args: unknown[]) => unknown).apply(target, args);
            return result === target ? receiver : result;
          };
        }
        return value;
      },
    }) as unknown as FindBuilder<TTable>;

    if (builderFn) {
      builderFn(wrapper);
    }

    if (userIndex && userIndex !== scopeResult.indexName) {
      throw new Error(
        `Scoped query for table "${tableName}" requires index "${scopeResult.indexName}", ` +
          `but query specified "${userIndex}".`,
      );
    }

    const combinedWhere = combineWhere<TTable>({
      base: userWhere,
      scope: scopeResult.where,
    });
    builder.whereIndex(scopeResult.indexName as string, combinedWhere as never);
  };
};

export const createScopedQueryInterface = <TSchema extends AnySchema, TContext>(
  options: ScopedQueryOptions<TSchema, TContext>,
): LofiQueryInterface<TSchema> => {
  if (!options.scope) {
    return options.query;
  }

  const { query, scope, context } = options;

  const wrap = <TableName extends keyof TSchema["tables"] & string>(
    tableName: TableName,
    builderFn?: (builder: FindBuilder<TSchema["tables"][TableName]>) => unknown,
  ) => {
    const scopeResult = scope({ tableName, context });
    if (!scopeResult) {
      return builderFn;
    }
    return wrapBuilderFn({
      tableName,
      builderFn,
      scopeResult: scopeResult as LofiQueryScopeResult<TSchema["tables"][TableName]>,
    });
  };

  return {
    find: ((tableName: string, builderFn?: (builder: FindBuilder<AnyTable>) => unknown) =>
      (query.find as (name: string, fn?: (builder: FindBuilder<AnyTable>) => unknown) => unknown)(
        tableName,
        wrap(tableName as never, builderFn as never) as never,
      )) as LofiQueryInterface<TSchema>["find"],
    findWithCursor: ((tableName: string, builderFn: (builder: FindBuilder<AnyTable>) => unknown) =>
      (
        query.findWithCursor as (
          name: string,
          fn: (builder: FindBuilder<AnyTable>) => unknown,
        ) => unknown
      )(
        tableName,
        wrap(tableName as never, builderFn as never) as never,
      )) as LofiQueryInterface<TSchema>["findWithCursor"],
    findFirst: ((tableName: string, builderFn?: (builder: FindBuilder<AnyTable>) => unknown) =>
      (
        query.findFirst as (
          name: string,
          fn?: (builder: FindBuilder<AnyTable>) => unknown,
        ) => unknown
      )(
        tableName,
        wrap(tableName as never, builderFn as never) as never,
      )) as LofiQueryInterface<TSchema>["findFirst"],
  };
};
