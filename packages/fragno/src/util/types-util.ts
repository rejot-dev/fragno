import type { StandardSchemaV1 } from "@standard-schema/spec";

export type InferOr<T, U> =
  T extends NonNullable<StandardSchemaV1>
    ? StandardSchemaV1.InferOutput<T>
    : T extends undefined
      ? U
      : U;

export type InferOrUnknown<T> = InferOr<T, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStandardSchema = StandardSchemaV1<any>;

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export type EmptyObject = Record<never, never>;
