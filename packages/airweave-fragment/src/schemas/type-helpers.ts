import { object, ZodObject, ZodType } from "zod";
import type { $strip } from "zod/v4/core";

type ExtraKeys<Schema, Model> = Exclude<keyof Schema, keyof Model>;
type ThrowIfExtraKeys<Schema, Model> =
  ExtraKeys<Schema, Model> extends never ? unknown : { [key: string]: never };

// From: https://github.com/colinhacks/zod/issues/372#issuecomment-2972857949
// We use this helper to make sure that our Zod models are identical to the interfaces from AirweaveSDK.
// ZodType<T> helper can be used for this also but that doesn't prevent additional keys from breaking type checking.
// The below function checks for this and improves the error message when it happens.
export function withZodSchema<Model>() {
  return <
    Schema extends { [K in keyof Model]: ZodType<Model[K]> } & ThrowIfExtraKeys<Schema, Model>,
  >(
    schema: Schema,
  ): ZodObject<Schema, $strip> => {
    return object(schema);
  };
}
