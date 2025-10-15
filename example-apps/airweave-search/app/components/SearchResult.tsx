import { useState } from "react";

interface SearchResultProps {
  result: Record<string, unknown>;
  index: number;
}

function getStringField(obj: unknown, field: string): string | undefined {
  if (obj && typeof obj === "object" && !Array.isArray(obj) && field in obj) {
    const value = (obj as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function getArrayField(obj: unknown, field: string): unknown[] {
  if (obj && typeof obj === "object" && !Array.isArray(obj) && field in obj) {
    const value = (obj as Record<string, unknown>)[field];
    return Array.isArray(value) ? value : [];
  }
  return [];
}

function getObjectField(obj: unknown, field: string): Record<string, unknown> | undefined {
  if (obj && typeof obj === "object" && !Array.isArray(obj) && field in obj) {
    const value = (obj as Record<string, unknown>)[field];
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }
  return undefined;
}

export function SearchResult({ result, index }: SearchResultProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);

  const score = typeof result.score === "number" ? result.score : null;
  const payload = getObjectField(result, "payload") || {};

  // Extract common fields
  const name = getStringField(payload, "name") || "Unnamed Entity";
  const metadata = getObjectField(payload, "airweave_system_metadata");
  const entityType = metadata ? getStringField(metadata, "entity_type") || "Unknown" : "Unknown";
  const breadcrumbs = getArrayField(payload, "breadcrumbs");
  const url = getStringField(payload, "url");
  const sourceName = getStringField(payload, "source_name");

  // Filter out fields we don't want to show in detail view
  // TODO: filter from server side?
  const excludedFields = new Set([
    "content",
    "embeddable_text",
    "airweave_collection_id",
    "entity_id",
    "name",
    "breadcrumbs",
    "url",
    "source_name",
    "airweave_system_metadata",
  ]);

  // Get entity-specific metadata
  const entityMetadata = Object.entries(payload).filter(([key]) => !excludedFields.has(key));

  // Render breadcrumb path
  const breadcrumbPath =
    breadcrumbs.length > 0
      ? breadcrumbs
          .map((b) => getStringField(b, "name") || "")
          .filter(Boolean)
          .join("/")
      : null;

  return (
    <div
      id={`result-${index + 1}`}
      className={`scroll-mt-8 rounded-xl border-2 p-6 transition-all ${
        isExpanded
          ? "border-green-300 bg-gradient-to-br from-white to-green-50 shadow-lg dark:border-green-600 dark:from-gray-800 dark:to-gray-700"
          : "border-gray-200 bg-white hover:border-green-200 hover:shadow-md dark:border-gray-700 dark:bg-gray-800 dark:hover:border-green-600"
      }`}
    >
      {/* List View - Always Visible */}
      <div className="mb-2 flex items-start justify-between gap-4">
        <div
          className="pointer-fine:cursor-pointer min-w-0 flex-1"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <h3 className="m-0 text-lg font-semibold text-gray-900 dark:text-gray-100">
              <span className="font-light text-gray-500 dark:text-gray-400">#{index + 1}</span>{" "}
              {name}
            </h3>
            <span className="inline-block rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700 dark:bg-green-900 dark:text-green-300">
              {entityType}
            </span>
          </div>

          {breadcrumbPath && (
            <div className="mb-3 flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400">
              <svg
                className="h-4 w-4 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
              <span className="truncate">{breadcrumbPath}</span>
            </div>
          )}

          <div className="flex gap-4 text-sm text-gray-600 dark:text-gray-400">
            <div className="flex items-center gap-1">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
              <span>
                <strong className="font-semibold">Score:</strong> {score?.toFixed(4) || "N/A"}
              </span>
            </div>
            {sourceName && (
              <div className="flex items-center gap-1">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
                  />
                </svg>
                <span>
                  <strong className="font-semibold">Source:</strong> {sourceName}
                </span>
              </div>
            )}
          </div>
        </div>

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`flex-shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-all ${
            isExpanded
              ? "bg-green-600 text-white hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-600"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          }`}
        >
          {isExpanded ? "Show Less" : "Show Details"}
        </button>
      </div>

      {/* Expanded Detail View */}
      {isExpanded && (
        <div className="mt-4 border-t-2 border-green-100 pt-4 dark:border-green-800">
          {/* URL */}
          {url && (
            <div className="mb-4 flex items-start gap-2">
              <svg
                className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                />
              </svg>
              <div className="min-w-0 flex-1">
                <strong className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  URL:
                </strong>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 break-all text-sm text-green-600 hover:text-green-800 hover:underline dark:text-green-400 dark:hover:text-green-300"
                >
                  {url}
                </a>
              </div>
            </div>
          )}

          {/* Entity ID */}
          {getStringField(payload, "entity_id") && (
            <div className="mb-4 text-sm">
              <strong className="font-semibold text-gray-700 dark:text-gray-300">Entity ID:</strong>{" "}
              <code className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-400">
                {getStringField(payload, "entity_id")}
              </code>
            </div>
          )}

          {/* Entity-specific metadata */}
          {entityMetadata.length > 0 && (
            <div className="mb-4">
              <strong className="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300">
                Metadata
              </strong>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg bg-gray-50 p-4 text-sm dark:bg-gray-700/50">
                {entityMetadata.map(([key, value]) => (
                  <div key={key} className="contents">
                    <div className="font-medium text-gray-600 dark:text-gray-400">
                      {key.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())}:
                    </div>
                    <div className="break-words text-gray-800 dark:text-gray-200">
                      {typeof value === "object" && value !== null
                        ? JSON.stringify(value)
                        : String(value)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Airweave System Metadata Summary */}
          {metadata && (
            <details className="group mt-4">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-gray-600 transition-colors hover:text-green-600 dark:text-gray-400 dark:hover:text-green-400">
                <svg
                  className="h-4 w-4 transform transition-transform group-open:rotate-90"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
                System Metadata
              </summary>
              <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-gray-200 bg-gray-100 p-4 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
                {JSON.stringify(metadata, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
