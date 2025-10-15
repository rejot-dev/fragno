import { AirweaveSDK } from "@airweave/sdk";

import { z } from "zod";
import { withZodSchema } from "./type-helpers";

export const sourceConnectionSchema = withZodSchema<AirweaveSDK.SourceConnectionListItem>()({
  id: z.string(),
  name: z.string(),
  short_name: z.string(),
  readable_collection_id: z.string(),
  created_at: z.string(),
  modified_at: z.string(),
  is_authenticated: z.boolean(),
  entity_count: z.number().optional(),
  auth_method: z.enum(["direct", "oauth_browser", "oauth_token", "oauth_byoc", "auth_provider"]),
  status: z.enum(["active", "pending_auth", "syncing", "error", "inactive", "pending_sync"]),
});

export const sourceConnectionsRequestSchema = z.object({
  collection: z.string().optional(),
  skip: z.number().int().optional(),
  limit: z.number().int().optional(),
});

export const sourceConnectionsResponseSchema = z.array(sourceConnectionSchema);

export type SourceConnection = z.infer<typeof sourceConnectionSchema>;
export type SourceConnectionsRequest = z.infer<typeof sourceConnectionsRequestSchema>;
