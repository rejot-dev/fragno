import { AirweaveSDK } from "@airweave/sdk";

import { z } from "zod";
import { withZodSchema } from "./type-helpers";

export const collectionSchema = withZodSchema<AirweaveSDK.Collection>()({
  id: z.string(),
  name: z.string(),
  readable_id: z.string(),
  created_at: z.string(),
  modified_at: z.string(),
  organization_id: z.string(),
  created_by_email: z.string().optional(),
  modified_by_email: z.string().optional(),
  status: z.enum(["ACTIVE", "NEEDS SOURCE", "ERROR"]).optional(),
});

export const collectionsResponseSchema = z.array(collectionSchema);

export type Collection = z.infer<typeof collectionSchema>;
