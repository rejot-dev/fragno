import { AirweaveSDK } from "@airweave/sdk";

import { z } from "zod";
import { withZodSchema } from "./type-helpers";

export const searchRequestSchema = withZodSchema<AirweaveSDK.SearchRequest>()({
  query: z.string(),
  retrieval_strategy: z.enum(["hybrid", "neural", "keyword"]).optional(),
  filter: z.record(z.string(), z.any()).optional(),
  offset: z.number().int().optional(),
  limit: z.number().int().optional(),
  temporal_relevance: z.number().optional(),
  expand_query: z.boolean().optional(),
  interpret_filters: z.boolean().optional(),
  rerank: z.boolean().optional(),
  generate_answer: z.boolean().optional(),
});

export const searchResponseSchema = withZodSchema<AirweaveSDK.SearchResponse>()({
  results: z.array(z.record(z.string(), z.unknown())),
  completion: z.string().optional(),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
