import { AirweaveSDK } from "@airweave/sdk";

import { z } from "zod";
import { fieldsSchema } from "./config";
import { withZodSchema } from "./type-helpers";

export const sourceSchema = withZodSchema<AirweaveSDK.Source>()({
  name: z.string(),
  description: z.string().optional(),
  auth_methods: z.array(z.string()).optional(),
  oauth_type: z.string().optional(),
  requires_byoc: z.boolean().optional(),
  auth_config_class: z.string().optional(),
  config_class: z.string().optional(),
  short_name: z.string(),
  class_name: z.string(),
  output_entity_definition_ids: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  supports_continuous: z.boolean().optional(),
  id: z.string(),
  created_at: z.string(),
  modified_at: z.string(),
  auth_fields: fieldsSchema.optional(),
  config_fields: fieldsSchema,
  supported_auth_providers: z.array(z.string()).optional(),
});

export const sourcesResponseSchema = z.array(sourceSchema);

export type Source = z.infer<typeof sourceSchema>;
