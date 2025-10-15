import { z } from "zod";

// Generic event schema that accepts any event with a type field
// This allows all Airweave SSE events to pass through without
// needing to define Zod schemas for every single event type
export const streamSearchEventSchema = z
  .object({
    type: z.string(),
    ts: z.string().optional(),
    seq: z.number().optional(),
    op: z.string().nullable().optional(),
    op_seq: z.number().nullable().optional(),
    request_id: z.string().optional(),
  })
  .loose();

// Array schema for streaming (required by Fragno's jsonStream)
export const streamSearchEventsSchema = z.array(streamSearchEventSchema);

export type StreamSearchEvents = z.infer<typeof streamSearchEventsSchema>;

/*
Below code was directly vendored from Airweave repo as the NPM SDK doesn't provide SSE event schemas
https://github.com/airweave-ai/airweave/blob/main/frontend/src/search/types.ts
*/

export type ISODate = string;

// Base event fields shared across many events
export interface BaseEvent {
  type: string;
  ts?: ISODate;
  seq?: number;
  op?: string | null;
  op_seq?: number | null;
  request_id?: string;
  [key: string]: unknown; // Allow additional properties
}

// Connection & lifecycle
export interface ConnectedEvent extends BaseEvent {
  type: "connected";
  request_id: string;
}

export interface StartEvent extends BaseEvent {
  type: "start";
  query: string;
  limit: number;
  offset: number;
}

export interface DoneEvent extends BaseEvent {
  type: "done";
}

export interface CancelledEvent extends BaseEvent {
  type: "cancelled";
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  message: string;
  operation?: string;
}

export interface HeartbeatEvent extends BaseEvent {
  type: "heartbeat";
}

export interface SummaryEvent extends BaseEvent {
  type: "summary";
  timings: Record<string, number>;
  errors: unknown[];
  total_time_ms: number;
}

// Operator boundaries
export interface OperatorStartEvent extends BaseEvent {
  type: "operator_start";
  name: string;
}

export interface OperatorEndEvent extends BaseEvent {
  type: "operator_end";
  name: string;
  ms: number;
}

// Query interpretation
export interface InterpretationStartEvent extends BaseEvent {
  type: "interpretation_start";
  model: string;
  strategy?: string;
}

export interface InterpretationReasonDeltaEvent extends BaseEvent {
  type: "interpretation_reason_delta";
  text: string;
}

export interface InterpretationDeltaEvent extends BaseEvent {
  type: "interpretation_delta";
  parsed_snapshot: {
    filters: unknown[];
    confidence?: number;
    refined_query?: string;
  };
}

export interface InterpretationSkippedEvent extends BaseEvent {
  type: "interpretation_skipped";
  reason: string;
  confidence?: number;
  threshold?: number;
}

export interface FilterAppliedEvent extends BaseEvent {
  type: "filter_applied";
  filter: unknown | null;
  source?: string;
}

export interface FilterMergeEvent extends BaseEvent {
  type: "filter_merge";
  existing?: unknown;
  user?: unknown;
  merged: unknown;
}

// Query expansion
export interface ExpansionStartEvent extends BaseEvent {
  type: "expansion_start";
  model: string;
  strategy: string;
}

export interface ExpansionReasonDeltaEvent extends BaseEvent {
  type: "expansion_reason_delta";
  text: string;
}

export interface ExpansionDeltaEvent extends BaseEvent {
  type: "expansion_delta";
  alternatives_snapshot: string[];
}

export interface ExpansionDoneEvent extends BaseEvent {
  type: "expansion_done";
  alternatives: string[];
}

// Recency
export interface RecencyStartEvent extends BaseEvent {
  type: "recency_start";
  requested_weight: number;
}

export interface RecencySpanEvent extends BaseEvent {
  type: "recency_span";
  field: string;
  oldest: string;
  newest: string;
  span_seconds: number;
}

export interface RecencySkippedEvent extends BaseEvent {
  type: "recency_skipped";
  reason: "weight_zero" | "no_field" | string;
}

// Embedding
export interface EmbeddingStartEvent extends BaseEvent {
  type: "embedding_start";
  search_method: "hybrid" | "neural" | "keyword";
}

export interface EmbeddingDoneEvent extends BaseEvent {
  type: "embedding_done";
  neural_count: number;
  dim: number;
  model: string;
  sparse_count: number | null;
  avg_nonzeros: number | null;
}

export interface EmbeddingFallbackEvent extends BaseEvent {
  type: "embedding_fallback";
  reason?: string;
}

// Vector search
export interface VectorSearchStartEvent extends BaseEvent {
  type: "vector_search_start";
  embeddings: number;
  method: "hybrid" | "neural" | "keyword";
  limit: number;
  offset: number;
  threshold: number | null;
  has_sparse: boolean;
  has_filter: boolean;
  decay_weight?: number;
}

export interface VectorSearchBatchEvent extends BaseEvent {
  type: "vector_search_batch";
  fetched: number;
  unique: number;
  dedup_dropped: number;
  top_scores?: number[];
}

export interface VectorSearchDoneEvent extends BaseEvent {
  type: "vector_search_done";
  final_count: number;
  top_scores?: number[];
}

export interface VectorSearchNoResultsEvent extends BaseEvent {
  type: "vector_search_no_results";
  reason: string;
  has_filter: boolean;
}

// Reranking
export interface RerankingStartEvent extends BaseEvent {
  type: "reranking_start";
  model: string;
  strategy: string;
  k: number;
}

export interface RerankingReasonDeltaEvent extends BaseEvent {
  type: "reranking_reason_delta";
  text: string;
}

export interface RerankingDeltaEvent extends BaseEvent {
  type: "reranking_delta";
  rankings_snapshot: Array<{ index: number; relevance_score: number }>;
}

export interface RankingsEvent extends BaseEvent {
  type: "rankings";
  rankings: Array<{ index: number; relevance_score: number }>;
}

export interface RerankingDoneEvent extends BaseEvent {
  type: "reranking_done";
  rankings: Array<{ index: number; relevance_score: number }>;
  applied: boolean;
}

// Completion (answer generation)
export interface AnswerContextBudgetEvent extends BaseEvent {
  type: "answer_context_budget";
  total_results: number;
  results_in_context: number;
  excluded: number;
}

export interface CompletionDoneEvent extends BaseEvent {
  type: "completion_done";
  text: string;
}

// Results
export interface ResultsEvent extends BaseEvent {
  type: "results";
  results: Record<string, unknown>[];
}

// Union of all known events
export type StreamSearchEvent =
  | ConnectedEvent
  | StartEvent
  | OperatorStartEvent
  | OperatorEndEvent
  | InterpretationStartEvent
  | InterpretationReasonDeltaEvent
  | InterpretationDeltaEvent
  | InterpretationSkippedEvent
  | FilterAppliedEvent
  | FilterMergeEvent
  | ExpansionStartEvent
  | ExpansionReasonDeltaEvent
  | ExpansionDeltaEvent
  | ExpansionDoneEvent
  | RecencyStartEvent
  | RecencySpanEvent
  | RecencySkippedEvent
  | EmbeddingStartEvent
  | EmbeddingDoneEvent
  | EmbeddingFallbackEvent
  | VectorSearchStartEvent
  | VectorSearchBatchEvent
  | VectorSearchDoneEvent
  | VectorSearchNoResultsEvent
  | RerankingStartEvent
  | RerankingReasonDeltaEvent
  | RerankingDeltaEvent
  | RankingsEvent
  | RerankingDoneEvent
  | AnswerContextBudgetEvent
  | CompletionDoneEvent
  | ResultsEvent
  | SummaryEvent
  | HeartbeatEvent
  | ErrorEvent
  | DoneEvent
  | CancelledEvent;
