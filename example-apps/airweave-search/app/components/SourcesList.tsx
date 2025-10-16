import { useSources } from "~/lib/airweave-client";

export function SourcesList() {
  const { data: sources, loading, error } = useSources();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-pulse text-lg font-medium text-green-600">Loading sources...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-red-700 dark:text-red-400">
        <strong className="font-semibold">Error loading sources:</strong> {error.message}
      </div>
    );
  }

  if (!sources || sources.length === 0) {
    return (
      <div className="rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 py-12 text-center">
        <p className="text-lg text-gray-500 dark:text-gray-400">No sources available.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100">
          Available Sources <span className="font-normal text-gray-500 dark:text-gray-400">({sources.length})</span>
        </h2>
        <p className="mt-1 text-gray-600 dark:text-gray-400">Data source connectors that Airweave can connect to</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {sources.map(
          (source: {
            id: string;
            name: string;
            short_name: string;
            description?: string;
            labels?: string[];
            auth_methods?: string[];
            supports_continuous?: boolean;
          }) => (
            <div
              key={source.id}
              className="rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 transition-all hover:border-green-500 dark:hover:border-green-400"
            >
              {/* Header */}
              <div className="mb-3">
                <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100">{source.name}</h3>
                <p className="font-mono text-sm text-gray-500 dark:text-gray-400">{source.short_name}</p>
              </div>

              {/* Description */}
              {source.description && (
                <p className="mb-4 line-clamp-3 text-sm text-gray-600 dark:text-gray-400">{source.description}</p>
              )}

              {/* Labels */}
              {source.labels && source.labels.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {source.labels.map((label: string) => (
                    <span
                      key={label}
                      className="rounded bg-green-100 dark:bg-green-900 px-2 py-1 text-xs font-medium text-green-700 dark:text-green-300"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              )}

              {/* Auth Methods */}
              {source.auth_methods && source.auth_methods.length > 0 && (
                <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
                  <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Authentication:</p>
                  <div className="flex flex-wrap gap-1">
                    {source.auth_methods.map((method: string) => (
                      <span
                        key={method}
                        className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-1 font-mono text-xs text-gray-700 dark:text-gray-300"
                      >
                        {method}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Continuous Sync Badge */}
              {source.supports_continuous && (
                <div className="mt-3">
                  <span className="inline-flex items-center rounded bg-blue-100 dark:bg-blue-900 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-300">
                    <svg className="mr-1 h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Continuous Sync
                  </span>
                </div>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
