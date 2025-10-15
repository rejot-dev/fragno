import { z } from "zod";
import { AirweaveSDK } from "@airweave/sdk";
import { withZodSchema } from "./type-helpers";

// Zod schema for ConfigField
export const configFieldSchema = withZodSchema<AirweaveSDK.ConfigField>()({
  name: z.string(),
  title: z.string(),
  description: z.string().optional(),
  type: z.string(),
  required: z.boolean().optional(),
});

// Zod schema for Fields
export const fieldsSchema = withZodSchema<AirweaveSDK.Fields>()({
  fields: z.array(configFieldSchema),
});

// Exported types
export type ConfigField = z.infer<typeof configFieldSchema>;
export type Fields = z.infer<typeof fieldsSchema>;
