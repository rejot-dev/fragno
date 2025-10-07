import type { AnySchema, AnyTable } from "../schema/create";
import type { Condition, ConditionBuilder } from "./condition-builder";
import type { FindFirstOptions, FindManyOptions, SelectClause } from "./query";

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
  [K in keyof T["columns"]]?: T["columns"][K] extends { isIdColumn: true }
    ? never
    : T["columns"][K]["$in"];
};

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
