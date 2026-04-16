import type { IdColumn, AnyTable, Relation } from "../schema/create";
import type { Prettify } from "../util/types";
import type { Condition, ConditionBuilder } from "./condition-builder";
import type { FindBuilder } from "./unit-of-work/unit-of-work";

export type AnySelectClause = SelectClause<AnyTable>;

export type SelectClause<T extends AnyTable> = true | readonly (keyof T["columns"])[];

export type RawColumnValues<T extends AnyTable> = {
  [K in keyof T["columns"] as string extends K ? never : K]: T["columns"][K]["$out"];
};

export type TableToColumnValues<T extends AnyTable> = Prettify<RawColumnValues<T>>;

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
  : S extends readonly (keyof T["columns"])[]
    ? Prettify<{
        [K in S[number] as string extends K ? never : K]: K extends keyof T["columns"]
          ? T["columns"][K]["$out"]
          : never;
      }>
    : never;

export type SelectResult<T extends AnyTable, JoinOut, Select extends SelectClause<T>> = Prettify<
  MainSelectResult<Select, T> & JoinOut
>;

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
        Prettify<
          Out & {
            [$K in K]: MapRelationType<SelectResult<Target, JoinOut, Select>>[Type];
          }
        >
      >
    : never;
};

export type OrderBy<Column = string> = [columnName: Column, "asc" | "desc"];

/**
 * Extract Select type parameter from a FindBuilder type (handles Omit wrapper)
 * @internal
 */
export type ExtractSelect<T> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends FindBuilder<any, infer TSelect, any>
    ? TSelect
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      T extends Omit<FindBuilder<any, infer TSelect, any>, any>
      ? TSelect
      : true;

/**
 * Extract JoinOut type parameter from a FindBuilder type (handles Omit wrapper)
 * @internal
 */
export type ExtractJoinOut<T> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends FindBuilder<any, any, infer TJoinOut>
    ? TJoinOut
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      T extends Omit<FindBuilder<any, any, infer TJoinOut>, any>
      ? TJoinOut
      : {};

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
