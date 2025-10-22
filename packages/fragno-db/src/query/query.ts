import type { IdColumn, AnySchema, AnyTable, Relation, FragnoId } from "../schema/create";
import type { Condition, ConditionBuilder } from "./condition-builder";
import type {
  UnitOfWork,
  FindBuilder,
  UpdateBuilder,
  DeleteBuilder,
  UpdateManyBuilder,
} from "./unit-of-work";
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

interface MapRelationType<Type> {
  one: Type | null;
  many: Type[];
}

export type JoinBuilder<T extends AnyTable, Out = {}> = {
  [K in keyof T["relations"]]: T["relations"][K] extends Relation<infer Type, infer Target>
    ? <Select extends SelectClause<Target> = true, JoinOut = {}>(
        options?: FindManyOptions<Target, Select, JoinOut, false>,
      ) => JoinBuilder<
        T,
        Out & {
          [$K in K]: MapRelationType<SelectResult<Target, JoinOut, Select>>[Type];
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
   * Find multiple records using a builder pattern
   */
  find: <
    TableName extends keyof TSchema["tables"] & string,
    Select extends SelectClause<TSchema["tables"][TableName]> = true,
    JoinOut = {},
  >(
    table: TableName,
    builderFn?: (
      builder: Omit<FindBuilder<TSchema["tables"][TableName]>, "build">,
    ) => Omit<FindBuilder<TSchema["tables"][TableName], Select, JoinOut>, "build">,
  ) => Promise<SelectResult<TSchema["tables"][TableName], JoinOut, Select>[]>;

  /**
   * Find the first record matching the criteria
   * Implemented as a wrapper around find() with pageSize(1)
   */
  findFirst: <
    TableName extends keyof TSchema["tables"] & string,
    Select extends SelectClause<TSchema["tables"][TableName]> = true,
    JoinOut = {},
  >(
    table: TableName,
    builderFn?: (
      builder: Omit<FindBuilder<TSchema["tables"][TableName]>, "build">,
    ) => Omit<FindBuilder<TSchema["tables"][TableName], Select, JoinOut>, "build">,
  ) => Promise<SelectResult<TSchema["tables"][TableName], JoinOut, Select> | null>;

  /**
   * Create a single record
   * @returns The ID of the created record
   */
  create: <TableName extends keyof TSchema["tables"] & string>(
    table: TableName,
    values: TableToInsertValues<TSchema["tables"][TableName]>,
  ) => Promise<FragnoId>;

  /**
   * Create multiple records
   * @returns Array of IDs of the created records
   */
  createMany: <TableName extends keyof TSchema["tables"] & string>(
    table: TableName,
    values: TableToInsertValues<TSchema["tables"][TableName]>[],
  ) => Promise<FragnoId[]>;

  /**
   * Update a single record by ID
   * Note: you cannot update the id of a row, some databases don't support that (including MongoDB).
   */
  update: <TableName extends keyof TSchema["tables"] & string>(
    table: TableName,
    id: FragnoId | string,
    builderFn: (
      builder: Omit<UpdateBuilder<TSchema["tables"][TableName]>, "build" | "check">,
    ) => Omit<UpdateBuilder<TSchema["tables"][TableName]>, "build">,
  ) => Promise<void>;

  /**
   * Update multiple records matching a where clause
   * Note: you cannot update the id of a row, some databases don't support that (including MongoDB).
   */
  updateMany: <TableName extends keyof TSchema["tables"] & string>(
    table: TableName,
    builderFn: (builder: UpdateManyBuilder<TSchema["tables"][TableName]>) => void,
  ) => Promise<void>;

  /**
   * Delete a single record by ID
   */
  delete: <TableName extends keyof TSchema["tables"] & string>(
    table: TableName,
    id: FragnoId | string,
    builderFn?: (builder: Omit<DeleteBuilder, "build">) => Omit<DeleteBuilder, "build" | "check">,
  ) => Promise<void>;

  /**
   * Delete multiple records matching a where clause
   */
  deleteMany: <TableName extends keyof TSchema["tables"] & string>(
    table: TableName,
    builderFn: (
      builder: Omit<FindBuilder<TSchema["tables"][TableName]>, "build" | "check">,
    ) => void,
  ) => Promise<void>;

  /**
   * Create a Unit of Work bound to this query engine
   */
  createUnitOfWork: (name?: string, config?: TUOWConfig) => UnitOfWork<TSchema, []>;
}
