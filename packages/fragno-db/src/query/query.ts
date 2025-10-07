import type { IdColumn, AnySchema, AnyTable, Relation } from "../schema/create";
import type { Condition, ConditionBuilder } from "./condition-builder";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type EmptyObject = {};

export type AnySelectClause = SelectClause<AnyTable>;

export type SelectClause<T extends AnyTable> = true | (keyof T["columns"])[];

type TableToColumnValues<T extends AnyTable> = {
  [K in keyof T["columns"]]: T["columns"][K]["$out"];
};

type PickNullable<T> = {
  [P in keyof T as null extends T[P] ? P : never]: T[P];
};

type PickNotNullable<T> = {
  [P in keyof T as null extends T[P] ? never : P]: T[P];
};

type TableToInsertValues<T extends AnyTable> = Partial<
  PickNullable<{
    [K in keyof T["columns"]]: T["columns"][K]["$in"];
  }>
> &
  PickNotNullable<{
    [K in keyof T["columns"]]: T["columns"][K]["$in"];
  }>;

type TableToUpdateValues<T extends AnyTable> = {
  [K in keyof T["columns"]]?: T["columns"][K] extends IdColumn ? never : T["columns"][K]["$in"];
};

type MainSelectResult<S extends SelectClause<T>, T extends AnyTable> = S extends true
  ? TableToColumnValues<T>
  : S extends (keyof T["columns"])[]
    ? Pick<TableToColumnValues<T>, S[number]>
    : never;

type SelectResult<T extends AnyTable, JoinOut, Select extends SelectClause<T>> = MainSelectResult<
  Select,
  T
> &
  JoinOut;

export type JoinBuilder<TTable extends AnyTable> = {
  [K in keyof TTable["relations"]]: TTable["relations"][K] extends Relation<
    infer _Type,
    infer TTargetTable
  >
    ? (
        options?: FindManyOptions<TTargetTable, SelectClause<TTargetTable>, EmptyObject, false>,
      ) => void
    : never;
};

export type OrderBy<Column = string> = [columnName: Column, "asc" | "desc"];

export type FindFirstOptions<
  T extends AnyTable = AnyTable,
  Select extends SelectClause<T> = SelectClause<T>,
  JoinOut = EmptyObject,
  IsRoot extends boolean = true,
> = Omit<
  FindManyOptions<T, Select, JoinOut, IsRoot>,
  IsRoot extends true ? "limit" : "limit" | "offset" | "orderBy"
>;

export type FindManyOptions<
  T extends AnyTable = AnyTable,
  Select extends SelectClause<T> = SelectClause<T>,
  _JoinOut = EmptyObject,
  IsRoot extends boolean = true,
> = {
  select?: Select;
  where?: (eb: ConditionBuilder<T["columns"]>) => Condition | boolean;
  limit?: number;
  orderBy?: OrderBy<keyof T["columns"]> | OrderBy<keyof T["columns"]>[];
  join?: (jb: JoinBuilder<T>) => void;
} & (IsRoot extends true
  ? {
      // drizzle doesn't support `offset` in join queries (this may be changed in future, we can add it back)
      offset?: number;
    }
  : EmptyObject);

export interface AbstractQuery<S extends AnySchema> {
  /**
   * Count (all)
   */
  count: <TableName extends keyof S["tables"]>(
    table: TableName,
    v?: {
      where?: (eb: ConditionBuilder<S["tables"][TableName]["columns"]>) => Condition | boolean;
    },
  ) => Promise<number>;

  findFirst: <
    TableName extends keyof S["tables"],
    JoinOut = EmptyObject,
    Select extends SelectClause<S["tables"][TableName]> = true,
  >(
    table: TableName,
    v: FindFirstOptions<S["tables"][TableName], Select, JoinOut>,
  ) => Promise<SelectResult<S["tables"][TableName], JoinOut, Select> | null>;

  findMany: <
    TableName extends keyof S["tables"],
    JoinOut = EmptyObject,
    Select extends SelectClause<S["tables"][TableName]> = true,
  >(
    table: TableName,
    v?: FindManyOptions<S["tables"][TableName], Select, JoinOut>,
  ) => Promise<SelectResult<S["tables"][TableName], JoinOut, Select>[]>;

  /**
   * Note: you cannot update the id of a row, some databases don't support that (including MongoDB).
   */
  updateMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    v: {
      where?: (eb: ConditionBuilder<S["tables"][TableName]["columns"]>) => Condition | boolean;
      set: TableToUpdateValues<S["tables"][TableName]>;
    },
  ) => Promise<void>;

  createMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    values: TableToInsertValues<S["tables"][TableName]>[],
  ) => Promise<
    {
      _id: string;
    }[]
  >;

  /**
   * Note: when you don't need to receive the result, always use `createMany` for better performance.
   */
  create: <TableName extends keyof S["tables"]>(
    table: TableName,
    values: TableToInsertValues<S["tables"][TableName]>,
  ) => Promise<TableToColumnValues<S["tables"][TableName]>>;

  deleteMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    v: {
      where?: (eb: ConditionBuilder<S["tables"][TableName]["columns"]>) => Condition | boolean;
    },
  ) => Promise<void>;
}

export interface AbstractQueryCompiler<S extends AnySchema, TOutput> {
  /**
   * Compile a count query
   * Returns null if the where condition is always false
   */
  count: <TableName extends keyof S["tables"]>(
    table: TableName,
    v?: {
      where?: (eb: ConditionBuilder<S["tables"][TableName]["columns"]>) => Condition | boolean;
    },
  ) => TOutput | null;

  /**
   * Compile a findFirst query
   * Returns null if the where condition is always false
   */
  findFirst: <
    TableName extends keyof S["tables"],
    Select extends SelectClause<S["tables"][TableName]> = true,
  >(
    table: TableName,
    v: FindFirstOptions<S["tables"][TableName], Select>,
  ) => TOutput | null;

  /**
   * Compile a findMany query
   * Returns null if the where condition is always false
   */
  findMany: <
    TableName extends keyof S["tables"],
    Select extends SelectClause<S["tables"][TableName]> = true,
  >(
    table: TableName,
    v?: FindManyOptions<S["tables"][TableName], Select>,
  ) => TOutput | null;

  /**
   * Compile an updateMany query
   * Returns null if the where condition is always false
   */
  updateMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    v: {
      where?: (eb: ConditionBuilder<S["tables"][TableName]["columns"]>) => Condition | boolean;
      set: TableToUpdateValues<S["tables"][TableName]>;
    },
  ) => TOutput | null;

  /**
   * Compile a createMany query
   */
  createMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    values: TableToInsertValues<S["tables"][TableName]>[],
  ) => TOutput;

  /**
   * Compile a create query
   */
  create: <TableName extends keyof S["tables"]>(
    table: TableName,
    values: TableToInsertValues<S["tables"][TableName]>,
  ) => TOutput;

  /**
   * Compile a deleteMany query
   * Returns null if the where condition is always false
   */
  deleteMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    v: {
      where?: (eb: ConditionBuilder<S["tables"][TableName]["columns"]>) => Condition | boolean;
    },
  ) => TOutput | null;
}
