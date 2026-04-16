import type { CursorResult } from "@fragno-dev/db/cursor";
import type { AnySchema, AnyTable } from "@fragno-dev/db/schema";
import type { FindBuilder } from "@fragno-dev/db/unit-of-work";

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

type ExtractSelect<T> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends FindBuilder<any, infer TSelect, any>
    ? TSelect
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      T extends Omit<FindBuilder<any, infer TSelect, any>, any>
      ? TSelect
      : true;

type ExtractJoinOut<T> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends FindBuilder<any, any, infer TJoinOut>
    ? TJoinOut
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      T extends Omit<FindBuilder<any, any, infer TJoinOut>, any>
      ? TJoinOut
      : {};

/**
 * Async read helpers used by Lofi query engines.
 * Database-backed Fragno query engines should use createUnitOfWork(...) + uow.find(...).
 */
export interface AsyncQueryFindFamily<TSchema extends AnySchema> {
  find: {
    <TableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
      table: TableName,
      builderFn: (
        builder: Omit<FindBuilder<TSchema["tables"][TableName]>, "build">,
      ) => TBuilderResult,
    ): Promise<
      SelectResult<
        TSchema["tables"][TableName],
        ExtractJoinOut<TBuilderResult>,
        Extract<ExtractSelect<TBuilderResult>, SelectClause<TSchema["tables"][TableName]>>
      >[]
    >;
    <TableName extends keyof TSchema["tables"] & string>(
      table: TableName,
    ): Promise<SelectResult<TSchema["tables"][TableName], {}, true>[]>;
  };

  findWithCursor: <TableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    table: TableName,
    builderFn: (
      builder: Omit<FindBuilder<TSchema["tables"][TableName]>, "build">,
    ) => TBuilderResult,
  ) => Promise<
    CursorResult<
      SelectResult<
        TSchema["tables"][TableName],
        ExtractJoinOut<TBuilderResult>,
        Extract<ExtractSelect<TBuilderResult>, SelectClause<TSchema["tables"][TableName]>>
      >
    >
  >;

  findFirst: {
    <TableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
      table: TableName,
      builderFn: (
        builder: Omit<FindBuilder<TSchema["tables"][TableName]>, "build">,
      ) => TBuilderResult,
    ): Promise<SelectResult<
      TSchema["tables"][TableName],
      ExtractJoinOut<TBuilderResult>,
      Extract<ExtractSelect<TBuilderResult>, SelectClause<TSchema["tables"][TableName]>>
    > | null>;
    <TableName extends keyof TSchema["tables"] & string>(
      table: TableName,
    ): Promise<SelectResult<TSchema["tables"][TableName], {}, true> | null>;
  };
}
