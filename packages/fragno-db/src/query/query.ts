import type { IdColumn, AnySchema, AnyTable, Relation } from "../schema/create";
import type { Condition, ConditionBuilder } from "./condition-builder";
import type { UnitOfWork } from "./unit-of-work";
import type { Prettify } from "../util/types";

export type AnySelectClause = SelectClause<AnyTable>;

export type SelectClause<T extends AnyTable> = true | (keyof T["columns"])[];

export type RawColumnValues<T extends AnyTable> = {
  [K in keyof T["columns"] as string extends K ? never : K]: T["columns"][K]["$out"];
};

export type TableToColumnValues<T extends AnyTable> = RawColumnValues<T>;

type PickNullable<T> = {
  [P in keyof T as null extends T[P] ? P : never]: T[P];
};

type PickNotNullable<T> = {
  [P in keyof T as null extends T[P] ? never : P]: T[P];
};

type RawInsertValues<T extends AnyTable> = {
  [K in keyof T["columns"] as string extends K ? never : K]: T["columns"][K]["$in"];
};

export type TableToInsertValues<T extends AnyTable> = Prettify<
  Partial<PickNullable<RawInsertValues<T>>> & PickNotNullable<RawInsertValues<T>>
>;

export type TableToUpdateValues<T extends AnyTable> = {
  [K in keyof T["columns"] as string extends K ? never : K]?: T["columns"][K] extends IdColumn
    ? never
    : T["columns"][K]["$in"];
};

type MainSelectResult<S extends SelectClause<T>, T extends AnyTable> = S extends true
  ? TableToColumnValues<T>
  : S extends (keyof T["columns"])[]
    ? {
        [K in S[number] as string extends K ? never : K]: K extends keyof T["columns"]
          ? T["columns"][K]["$out"]
          : never;
      }
    : never;

export type SelectResult<
  T extends AnyTable,
  JoinOut,
  Select extends SelectClause<T>,
> = MainSelectResult<Select, T> & JoinOut;

interface MapRelationType<Type, Implied extends boolean> {
  one: Implied extends true ? Type | null : Type;
  many: Type[];
}

export type JoinBuilder<T extends AnyTable, Out = {}> = {
  [K in keyof T["relations"]]: T["relations"][K] extends Relation<infer Type, infer Target>
    ? <Select extends SelectClause<Target> = true, JoinOut = {}>(
        options?: FindManyOptions<Target, Select, JoinOut, false>,
      ) => JoinBuilder<
        T,
        Out & {
          [$K in K]: MapRelationType<SelectResult<Target, JoinOut, Select>, true>[Type];
        }
      >
    : never;
};

export type OrderBy<Column = string> = [columnName: Column, "asc" | "desc"];

export type FindFirstOptions<
  T extends AnyTable = AnyTable,
  Select extends SelectClause<T> = SelectClause<T>,
  JoinOut = {},
  IsRoot extends boolean = true,
> = Omit<
  FindManyOptions<T, Select, JoinOut, IsRoot>,
  IsRoot extends true ? "limit" : "limit" | "offset" | "orderBy"
>;

export type FindManyOptions<
  T extends AnyTable = AnyTable,
  Select extends SelectClause<T> = SelectClause<T>,
  _JoinOut = {},
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
  : {});

export interface AbstractQuery<TSchema extends AnySchema, TUOWConfig = void> {
  /**
   * Count (all)
   */
  count: <TableName extends keyof TSchema["tables"]>(
    table: TableName,
    v?: {
      where?: (
        eb: ConditionBuilder<TSchema["tables"][TableName]["columns"]>,
      ) => Condition | boolean;
    },
  ) => Promise<number>;

  findFirst: <
    TableName extends keyof TSchema["tables"],
    JoinOut = {},
    Select extends SelectClause<TSchema["tables"][TableName]> = true,
  >(
    table: TableName,
    v: FindFirstOptions<TSchema["tables"][TableName], Select, JoinOut>,
  ) => Promise<SelectResult<TSchema["tables"][TableName], JoinOut, Select> | null>;

  findMany: <
    TableName extends keyof TSchema["tables"],
    JoinOut = {},
    Select extends SelectClause<TSchema["tables"][TableName]> = true,
  >(
    table: TableName,
    v?: FindManyOptions<TSchema["tables"][TableName], Select, JoinOut>,
  ) => Promise<SelectResult<TSchema["tables"][TableName], JoinOut, Select>[]>;

  /**
   * Note: you cannot update the id of a row, some databases don't support that (including MongoDB).
   */
  updateMany: <TableName extends keyof TSchema["tables"]>(
    table: TableName,
    v: {
      where?: (
        eb: ConditionBuilder<TSchema["tables"][TableName]["columns"]>,
      ) => Condition | boolean;
      set: TableToUpdateValues<TSchema["tables"][TableName]>;
    },
  ) => Promise<void>;

  createMany: <TableName extends keyof TSchema["tables"]>(
    table: TableName,
    values: TableToInsertValues<TSchema["tables"][TableName]>[],
  ) => Promise<
    {
      _id: string;
    }[]
  >;

  /**
   * Note: when you don't need to receive the result, always use `createMany` for better performance.
   */
  create: <TableName extends keyof TSchema["tables"]>(
    table: TableName,
    values: TableToInsertValues<TSchema["tables"][TableName]>,
  ) => Promise<TableToColumnValues<TSchema["tables"][TableName]>>;

  deleteMany: <TableName extends keyof TSchema["tables"]>(
    table: TableName,
    v: {
      where?: (
        eb: ConditionBuilder<TSchema["tables"][TableName]["columns"]>,
      ) => Condition | boolean;
    },
  ) => Promise<void>;

  /**
   * Create a Unit of Work bound to this query engine
   */
  createUnitOfWork: (name?: string, config?: TUOWConfig) => UnitOfWork<TSchema, []>;
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
