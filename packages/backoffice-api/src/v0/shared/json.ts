import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z
  .lazy(() =>
    z.union([
      z.null(),
      z.boolean(),
      z.number(),
      z.string(),
      z.array(jsonValueSchema),
      z.record(z.string(), jsonValueSchema),
    ]),
  )
  .meta({ id: "JsonValue" });
