import type { StreamSearchEvent } from "@fragno-dev/airweave-fragment";

export function getLastEventDescription(events: StreamSearchEvent[]): string | null {
  if (events.length === 0) return null;

  const lastEvent = events[events.length - 1];

  switch (lastEvent.type) {
    case "connected":
      return "Connected to search service";
    case "start":
      return "Starting search";
    case "operator_start":
      return "name" in lastEvent ? `${lastEvent.name}` : "Processing";
    case "operator_end":
      return "name" in lastEvent ? `Completed ${lastEvent.name}` : "Step complete";
    case "interpretation_start":
      return "Interpreting query";
    case "interpretation_reason_delta":
    case "interpretation_delta":
      return "Analyzing query";
    case "interpretation_skipped":
      return "Skipped interpretation";
    case "filter_applied":
    case "filter_merge":
      return "Applying filters";
    case "expansion_start":
      return "Expanding query";
    case "expansion_reason_delta":
    case "expansion_delta":
      return "Generating alternatives";
    case "expansion_done":
      return "Query expanded";
    case "recency_start":
    case "recency_span":
      return "Applying recency";
    case "recency_skipped":
      return "Skipped recency";
    case "embedding_start":
      return "Creating embeddings";
    case "embedding_done":
      return "Embeddings created";
    case "embedding_fallback":
      return "Embedding fallback";
    case "vector_search_start":
      return "Searching collection";
    case "vector_search_batch":
      return "fetched" in lastEvent ? `Fetched ${lastEvent.fetched} results` : "Fetching results";
    case "vector_search_done":
      return "final_count" in lastEvent
        ? `Found ${lastEvent.final_count} results`
        : "Search complete";
    case "vector_search_no_results":
      return "No results found";
    case "reranking_start":
      return "Reranking results";
    case "reranking_reason_delta":
    case "reranking_delta":
      return "Analyzing relevance";
    case "rankings":
    case "reranking_done":
      return "Reranking complete";
    case "answer_context_budget":
      return "Preparing context";
    case "completion_done":
      return "AI answer complete";
    case "results":
      return "results" in lastEvent && Array.isArray(lastEvent.results)
        ? `Retrieved ${lastEvent.results.length} results`
        : "Results ready";
    case "summary":
      return "Finalizing";
    case "heartbeat":
      return "Processing";
    case "done":
      return "Search complete";
    case "cancelled":
      return "Search cancelled";
    case "error":
      return "message" in lastEvent ? `Error: ${lastEvent.message}` : "Error occurred";
    default:
      return "Processing";
  }
}

export function getCompletion(events: StreamSearchEvent[]): string | null {
  const completionDoneEvent = events.find((e) => e.type === "completion_done");
  if (
    completionDoneEvent &&
    "text" in completionDoneEvent &&
    typeof completionDoneEvent.text === "string"
  ) {
    return completionDoneEvent.text;
  }

  return null;
}

export function getSearchProgress(events: StreamSearchEvent[]): string {
  if (events.length === 0) return "";

  const lines: string[] = [];

  // Check for connection
  const connectedEvent = events.find((e) => e.type === "connected");
  const startEvent = events.find((e) => e.type === "start");

  if (connectedEvent || startEvent) {
    lines.push("Connected");
    if (startEvent && "query" in startEvent) {
      lines.push("Starting search");
    }
  }

  // Check for retrieval phase
  const embeddingStartEvent = events.find((e) => e.type === "embedding_start");
  const embeddingDoneEvent = events.find((e) => e.type === "embedding_done");
  const vectorSearchStartEvent = events.find((e) => e.type === "vector_search_start");
  const vectorSearchBatchEvents = events.filter((e) => e.type === "vector_search_batch");
  const vectorSearchDoneEvent = events.find((e) => e.type === "vector_search_done");

  if (embeddingStartEvent || vectorSearchStartEvent) {
    const method =
      embeddingStartEvent && "search_method" in embeddingStartEvent
        ? embeddingStartEvent.search_method
        : vectorSearchStartEvent && "method" in vectorSearchStartEvent
          ? vectorSearchStartEvent.method
          : "unknown";
    lines.push(`Retrieval: ${method}`);

    // Embedding details
    if (embeddingDoneEvent) {
      if ("neural_count" in embeddingDoneEvent) {
        const neuralCount = embeddingDoneEvent.neural_count;
        const dim = embeddingDoneEvent.dim;
        lines.push(`Embeddings: ${neuralCount} neural (dim ${dim})`);
      }
      if ("sparse_count" in embeddingDoneEvent && embeddingDoneEvent.sparse_count) {
        const sparseCount = embeddingDoneEvent.sparse_count;
        lines.push(`Embeddings: ${sparseCount} sparse (BM25)`);
      }
    }

    // Vector search progress
    if (vectorSearchBatchEvents.length > 0) {
      const lastBatch = vectorSearchBatchEvents[vectorSearchBatchEvents.length - 1];
      if ("fetched" in lastBatch) {
        lines.push(`Retrieved ${lastBatch.fetched} candidate results`);
      }
    }

    if (vectorSearchDoneEvent && "final_count" in vectorSearchDoneEvent) {
      lines.push("Retrieval complete");
    }
  }

  // Check for answer generation phase
  const answerContextEvent = events.find((e) => e.type === "answer_context_budget");
  const completionDoneEvent = events.find((e) => e.type === "completion_done");

  if (answerContextEvent || completionDoneEvent) {
    lines.push("Answer generation");

    if (answerContextEvent) {
      if (
        "total_results" in answerContextEvent &&
        "results_in_context" in answerContextEvent &&
        "excluded" in answerContextEvent
      ) {
        const { total_results, results_in_context, excluded } = answerContextEvent;
        lines.push(
          `Using ${results_in_context} of ${total_results} results in context (${excluded} excluded due to token limit)`,
        );
      }
    }

    if (completionDoneEvent) {
      lines.push("Answer generation complete");
    }
  }

  // Check for completion
  const doneEvent = events.find((e) => e.type === "done");
  const summaryEvent = events.find((e) => e.type === "summary");

  if (doneEvent || summaryEvent) {
    lines.push("Search complete");
  }

  return lines.join("\n");
}
