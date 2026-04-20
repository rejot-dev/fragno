import type { CursorResult } from "@fragno-dev/db/cursor";
import type { AnySchema, AnyTable } from "@fragno-dev/db/schema";
import type {
  ExtractQueryTreeBuilderCount,
  ExtractQueryTreeBuilderOut,
  ExtractQueryTreeBuilderSelect,
} from "@fragno-dev/db/unit-of-work";

import type { LofiFindBuilder } from "./query/read-plan";

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

type SelectClause<T extends AnyTable> = true | readonly (keyof T["columns"])[];

type RawColumnValues<T extends AnyTable> = {
  [K in keyof T["columns"] as string extends K ? never : K]: T["columns"][K]["$out"];
};

type TableToColumnValues<T extends AnyTable> = Prettify<RawColumnValues<T>>;

type MainSelectResult<S extends SelectClause<T>, T extends AnyTable> = S extends true
  ? TableToColumnValues<T>
  : S extends readonly (keyof T["columns"])[]
    ? Prettify<{
        [K in S[number] as string extends K ? never : K]: K extends keyof T["columns"]
          ? T["columns"][K]["$out"]
          : never;
      }>
    : never;

type SelectResult<T extends AnyTable, JoinOut, Select extends SelectClause<T>> = Prettify<
  MainSelectResult<Select, T> & JoinOut
>;

type QueryRow<TTable extends AnyTable, TBuilderResult> = SelectResult<
  TTable,
  ExtractQueryTreeBuilderOut<TBuilderResult>,
  Extract<ExtractQueryTreeBuilderSelect<TBuilderResult>, SelectClause<TTable>>
>;

type QueryFindResult<TTable extends AnyTable, TBuilderResult> =
  ExtractQueryTreeBuilderCount<TBuilderResult> extends true
    ? number
    : QueryRow<TTable, TBuilderResult>[];

type QueryFindFirstResult<TTable extends AnyTable, TBuilderResult> =
  ExtractQueryTreeBuilderCount<TBuilderResult> extends true
    ? number
    : QueryRow<TTable, TBuilderResult> | null;

/**
 * Async read helpers used by Lofi query engines.
 * Database-backed Fragno query engines should use createUnitOfWork(...) + uow.find(...).
 */
export interface AsyncQueryFindFamily<TSchema extends AnySchema> {
  find: <TableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    table: TableName,
    builderFn: (builder: LofiFindBuilder<TSchema, TableName>) => TBuilderResult,
  ) => Promise<QueryFindResult<TSchema["tables"][TableName], TBuilderResult>>;

  findWithCursor: <TableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    table: TableName,
    builderFn: (builder: LofiFindBuilder<TSchema, TableName>) => TBuilderResult,
  ) => Promise<
    CursorResult<
      SelectResult<
        TSchema["tables"][TableName],
        ExtractQueryTreeBuilderOut<TBuilderResult>,
        Extract<
          ExtractQueryTreeBuilderSelect<TBuilderResult>,
          SelectClause<TSchema["tables"][TableName]>
        >
      >
    >
  >;

  findFirst: <TableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    table: TableName,
    builderFn: (builder: LofiFindBuilder<TSchema, TableName>) => TBuilderResult,
  ) => Promise<QueryFindFirstResult<TSchema["tables"][TableName], TBuilderResult>>;
}
