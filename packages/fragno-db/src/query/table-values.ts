import type { AnyTable, IdColumn } from "../schema/create";
import type { Prettify } from "../util/types";

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
