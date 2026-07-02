import type { TSchema as TypeBoxSchema } from "typebox";

import type {
  AnyPiToolDefinition,
  PiToolDefinition,
  PiToolDetailsFromResultSchema,
  PiToolResultSchema,
} from "./types";

export function definePiTool<
  TParameters extends TypeBoxSchema,
  TResultSchema extends PiToolResultSchema<unknown>,
>(
  tool: PiToolDefinition<
    TParameters,
    PiToolDetailsFromResultSchema<TResultSchema>,
    TResultSchema
  > & {
    resultSchema: TResultSchema;
  },
): PiToolDefinition<TParameters, PiToolDetailsFromResultSchema<TResultSchema>, TResultSchema>;
export function definePiTool<TParameters extends TypeBoxSchema, TDetails>(
  tool: PiToolDefinition<TParameters, TDetails> & { resultSchema?: undefined },
): PiToolDefinition<TParameters, TDetails>;
export function definePiTool(tool: AnyPiToolDefinition): AnyPiToolDefinition {
  return tool;
}

export type {
  AnyPiToolDefinition,
  PiToolDefinition,
  PiToolDetailsFromResultSchema,
  PiToolResultSchema,
} from "./types";
