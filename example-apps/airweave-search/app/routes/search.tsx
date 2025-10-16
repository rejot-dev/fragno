import { useEffect, useState } from "react";
import { useSearch, useStreamSearch, useCollections } from "~/lib/airweave-client";
import type { StreamSearchEvent } from "@fragno-dev/airweave-fragment";
import { SearchResult } from "~/components/SearchResult";
import { AIAnswer } from "~/components/AIAnswer";
import {
  getLastEventDescription,
  getCompletion,
  getSearchProgress,
} from "~/components/StreamingEvents";
import { Layout } from "~/components/Layout";

export default function Home(): React.JSX.Element {
  const [query, setQuery] = useState("How to create a fragment?");
  const [selectedCollection, setSelectedCollection] = useState("");
  const [generateAnswer, setGenerateAnswer] = useState(true);
  const [useStreaming, setUseStreaming] = useState(true);
  const [retrievalStrategy, setRetrievalStrategy] = useState<"hybrid" | "neural" | "keyword">(
    "hybrid",
  );
  const [currentPage, setCurrentPage] = useState(1);
  const resultsPerPage = 100;
  const [isStreamingActive, setIsStreamingActive] = useState(false);

  const {
    data: collections,
    loading: collectionsLoading,
    error: collectionsError,
  } = useCollections();

  const { data: searchResults, loading: searching, error: searchError, mutate } = useSearch();

  const {
    data: streamingEvents,
    error: streamSearchError,
    mutate: mutateStream,
  } = useStreamSearch();

  // Derive the effective collection: use selected, or fallback to first collection
  const effectiveCollection = selectedCollection || collections?.[0]?.readable_id || "";

  const handleSearch = () => {
    if (!query.trim() || !effectiveCollection) return;

    setCurrentPage(1); // Reset to first page on new search

    const searchParams = {
      path: { collectionId: effectiveCollection },
      body: {
        query: query.trim(),
        generate_answer: generateAnswer,
        retrieval_strategy: retrievalStrategy,
        rerank: true,
      },
    };

    if (useStreaming) {
      setIsStreamingActive(true);
      mutateStream(searchParams);
    } else {
      mutate(searchParams);
    }
  };

  // Calculate pagination - support both streaming and non-streaming results
  const resultsFromStreamRaw = streamingEvents?.find(
    (e: { type: string; [key: string]: unknown }) => e.type === "results" && "results" in e,
  )?.results;
  const resultsFromStream = Array.isArray(resultsFromStreamRaw) ? resultsFromStreamRaw : [];
  const allResults = useStreaming ? resultsFromStream : searchResults?.results || [];
  const totalPages = Math.ceil(allResults.length / resultsPerPage);
  const startIndex = (currentPage - 1) * resultsPerPage;
  const endIndex = startIndex + resultsPerPage;
  const paginatedResults = allResults.slice(startIndex, endIndex);

  // Determine loading and error states
  const isSearching = useStreaming ? isStreamingActive : searching;
  const hasSearchError = useStreaming ? streamSearchError : searchError;

  // Get streaming status for button
  const streamingStatus =
    streamingEvents && streamingEvents.length > 0
      ? // TODO: align zod schema and interface types for SSE events
        getLastEventDescription(streamingEvents as StreamSearchEvent[])
      : isStreamingActive
        ? "Connecting..."
        : null;

  // Get AI completion from streaming events
  const streamingCompletion = streamingEvents
    ? // TODO: align zod schema and interface types for SSE events
      getCompletion(streamingEvents as StreamSearchEvent[])
    : null;

  // Check if search is complete
  const isStreamComplete =
    streamingEvents &&
    streamingEvents.some(
      (e: { type: string }) => e.type === "done" || e.type === "cancelled" || e.type === "summary",
    );

  // Update streaming active state when stream completes or errors
  useEffect(() => {
    if (isStreamComplete || streamSearchError) {
      setIsStreamingActive(false);
    }
  }, [isStreamComplete, streamSearchError]);

  return (
    <Layout activeTab="search">
      {/* Search Form */}
      <div className="mb-8 rounded-2xl bg-white p-8 shadow-lg dark:bg-gray-800">
        {/* Collection Selector */}
        <div className="mb-6">
          <label
            htmlFor="collection"
            className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-200"
          >
            Collection
          </label>
          {collectionsLoading && (
            <p className="italic text-gray-500 dark:text-gray-400">Loading collections...</p>
          )}
          {collectionsError && (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
              Error loading collections: {collectionsError.message}
            </p>
          )}
          {collections && (
            <select
              id="collection"
              value={effectiveCollection}
              onChange={(e) => setSelectedCollection(e.target.value)}
              className="w-full cursor-pointer rounded-lg border-2 border-gray-200 bg-white px-4 py-3 text-base text-gray-900 transition-all focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:focus:border-green-400 dark:focus:ring-green-900"
            >
              <option value="" disabled>
                Select a collection...
              </option>
              {collections.map((col: { id: string; readable_id: string; name: string }) => (
                <option key={col.id} value={col.readable_id}>
                  {col.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Search Input */}
        <div className="mb-6">
          <label
            htmlFor="query"
            className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-200"
          >
            Search Query
          </label>
          <input
            id="query"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Enter your search query..."
            className="w-full rounded-lg border-2 border-gray-200 bg-white px-4 py-3 text-base text-gray-900 transition-all placeholder:text-gray-400 focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-green-400 dark:focus:ring-green-900"
          />
        </div>

        {/* Advanced Options */}
        <details className="mb-6" open>
          <summary className="mb-3 cursor-pointer text-sm font-semibold text-gray-700 transition-colors hover:text-green-600 dark:text-gray-200 dark:hover:text-green-400">
            Advanced Options
          </summary>
          <div className="space-y-4 border-l-2 border-green-200 pl-4 pt-3 dark:border-green-800">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="generateAnswer"
                checked={generateAnswer}
                onChange={(e) => setGenerateAnswer(e.target.checked)}
                className="h-4 w-4 cursor-pointer rounded border-gray-300 bg-white text-green-600 focus:ring-2 focus:ring-green-500 dark:border-gray-600 dark:bg-gray-700 dark:text-green-500 dark:focus:ring-green-400"
              />
              <label
                htmlFor="generateAnswer"
                className="ml-2 cursor-pointer text-sm text-gray-700 dark:text-gray-300"
              >
                Generate AI Answer
              </label>
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="useStreaming"
                checked={useStreaming}
                onChange={(e) => setUseStreaming(e.target.checked)}
                className="h-4 w-4 cursor-pointer rounded border-gray-300 bg-white text-green-600 focus:ring-2 focus:ring-green-500 dark:border-gray-600 dark:bg-gray-700 dark:text-green-500 dark:focus:ring-green-400"
              />
              <label
                htmlFor="useStreaming"
                className="ml-2 cursor-pointer text-sm text-gray-700 dark:text-gray-300"
              >
                Use Streaming Search
              </label>
            </div>
            <div>
              <label
                htmlFor="strategy"
                className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                Retrieval Strategy
              </label>
              <select
                id="strategy"
                value={retrievalStrategy}
                onChange={(e) =>
                  setRetrievalStrategy(e.target.value as "hybrid" | "neural" | "keyword")
                }
                className="cursor-pointer rounded-lg border-2 border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 transition-all focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:focus:border-green-400 dark:focus:ring-green-900"
              >
                <option value="hybrid">Hybrid</option>
                <option value="neural">Neural</option>
                <option value="keyword">Keyword</option>
              </select>
            </div>
          </div>
        </details>

        {/* Search Button */}
        <button
          onClick={handleSearch}
          disabled={!query.trim() || !effectiveCollection || isSearching}
          className="w-full transform rounded-lg bg-gradient-to-r from-green-600 to-emerald-600 px-6 py-3 font-semibold text-white transition-all hover:scale-[1.02] hover:from-green-700 hover:to-emerald-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSearching ? (
            <span className="flex items-center justify-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
              {streamingStatus || "Searching..."}
            </span>
          ) : (
            "Search"
          )}
        </button>
      </div>

      {/* Streaming Progress Display */}
      {useStreaming && streamingEvents && streamingEvents.length > 0 && (
        <div className="mb-8 rounded-2xl border-2 border-green-200 bg-white p-6 shadow-lg dark:border-green-800 dark:bg-gray-800">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Trace</h3>
          <pre className="whitespace-pre-wrap font-mono text-sm text-gray-700 dark:text-gray-300">
            {
              // TODO: align zod schema and interface types for SSE events
              getSearchProgress(streamingEvents as StreamSearchEvent[])
            }
          </pre>
        </div>
      )}

      {/* Error Display */}
      {hasSearchError && (
        <div className="rounded-xl border-2 border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          <strong className="font-semibold">Search error:</strong> {hasSearchError.message}
        </div>
      )}

      {/* Streaming Results Display */}
      {useStreaming && streamingEvents && streamingEvents.length > 0 && (
        <div className="space-y-8">
          {/* AI Answer from streaming */}
          {streamingCompletion && <AIAnswer content={streamingCompletion} />}

          {/* Show paginated results for streaming too */}
          {allResults.length > 0 && (
            <div>
              <div className="mb-4">
                <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100">
                  Search Results{" "}
                  <span className="font-normal text-gray-500 dark:text-gray-400">
                    ({allResults.length})
                  </span>
                </h2>
              </div>
              <div className="space-y-4">
                {paginatedResults.map((result: Record<string, unknown>, idx: number) => {
                  if (!result.id) return null;
                  const actualIndex = startIndex + idx;
                  return <SearchResult key={actualIndex} result={result} index={actualIndex} />;
                })}
              </div>

              {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="mt-8 flex items-center justify-center gap-2">
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="rounded-lg border-2 border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 transition-all hover:border-green-500 hover:text-green-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-gray-300 disabled:hover:text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-green-400 dark:hover:text-green-400 dark:disabled:hover:border-gray-600 dark:disabled:hover:text-gray-300"
                  >
                    Previous
                  </button>

                  <div className="flex items-center gap-1">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => {
                      const showPage =
                        page === 1 || page === totalPages || Math.abs(page - currentPage) <= 1;
                      const showEllipsis =
                        (page === 2 && currentPage > 3) ||
                        (page === totalPages - 1 && currentPage < totalPages - 2);

                      if (showEllipsis) {
                        return (
                          <span key={page} className="px-2 text-gray-500 dark:text-gray-400">
                            ...
                          </span>
                        );
                      }

                      if (!showPage) return null;

                      return (
                        <button
                          key={page}
                          onClick={() => setCurrentPage(page)}
                          className={`min-w-[2.5rem] rounded-lg px-3 py-2 font-medium transition-all ${
                            currentPage === page
                              ? "bg-gradient-to-r from-green-600 to-emerald-600 text-white"
                              : "border-2 border-gray-300 bg-white text-gray-700 hover:border-green-500 hover:text-green-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-green-400 dark:hover:text-green-400"
                          }`}
                        >
                          {page}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="rounded-lg border-2 border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 transition-all hover:border-green-500 hover:text-green-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-gray-300 disabled:hover:text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-green-400 dark:hover:text-green-400 dark:disabled:hover:border-gray-600 dark:disabled:hover:text-gray-300"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Non-streaming Results Display */}
      {!useStreaming && searchResults && (
        <div>
          {/* AI-Generated Answer */}
          {searchResults.completion && <AIAnswer content={searchResults.completion} />}

          {/* Search Results */}
          <div className="mb-4">
            <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100">
              Results{" "}
              <span className="font-normal text-gray-500 dark:text-gray-400">
                ({allResults.length})
              </span>
            </h2>
          </div>

          {allResults.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-gray-300 bg-white py-12 text-center dark:border-gray-600 dark:bg-gray-800">
              <p className="text-lg text-gray-500 dark:text-gray-400">No results found.</p>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                {paginatedResults.map((result: Record<string, unknown>, idx: number) => {
                  if (!result.id) return null;
                  const actualIndex = startIndex + idx;
                  return <SearchResult key={actualIndex} result={result} index={actualIndex} />;
                })}
              </div>

              {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="mt-8 flex items-center justify-center gap-2">
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="rounded-lg border-2 border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 transition-all hover:border-green-500 hover:text-green-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-gray-300 disabled:hover:text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-green-400 dark:hover:text-green-400 dark:disabled:hover:border-gray-600 dark:disabled:hover:text-gray-300"
                  >
                    Previous
                  </button>

                  <div className="flex items-center gap-1">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => {
                      // Show first page, last page, current page, and pages near current
                      const showPage =
                        page === 1 || page === totalPages || Math.abs(page - currentPage) <= 1;
                      const showEllipsis =
                        (page === 2 && currentPage > 3) ||
                        (page === totalPages - 1 && currentPage < totalPages - 2);

                      if (showEllipsis) {
                        return (
                          <span key={page} className="px-2 text-gray-500 dark:text-gray-400">
                            ...
                          </span>
                        );
                      }

                      if (!showPage) return null;

                      return (
                        <button
                          key={page}
                          onClick={() => setCurrentPage(page)}
                          className={`min-w-[2.5rem] rounded-lg px-3 py-2 font-medium transition-all ${
                            currentPage === page
                              ? "bg-gradient-to-r from-green-600 to-emerald-600 text-white"
                              : "border-2 border-gray-300 bg-white text-gray-700 hover:border-green-500 hover:text-green-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-green-400 dark:hover:text-green-400"
                          }`}
                        >
                          {page}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="rounded-lg border-2 border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 transition-all hover:border-green-500 hover:text-green-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-gray-300 disabled:hover:text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-green-400 dark:hover:text-green-400 dark:disabled:hover:border-gray-600 dark:disabled:hover:text-gray-300"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Layout>
  );
}
