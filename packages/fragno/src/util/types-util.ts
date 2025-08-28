import type { StandardSchemaV1 } from "@standard-schema/spec";

export type InferOr<T, U> =
  T extends NonNullable<StandardSchemaV1>
    ? StandardSchemaV1.InferOutput<T>
    : T extends undefined
      ? U
      : U;

export type InferOrUnknown<T> = InferOr<T, unknown>;
