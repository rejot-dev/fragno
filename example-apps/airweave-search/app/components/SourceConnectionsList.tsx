import { useState } from "react";
import { useSourceConnections, useCollections } from "~/lib/airweave-client";

export function SourceConnectionsList() {
  const [selectedCollection, setSelectedCollection] = useState("");
  const [skip, setSkip] = useState(0);
  const [limit, setLimit] = useState(50);

  const { data: collections } = useCollections();

  const { data: connections, loading, error } = useSourceConnections();

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 border-green-200 dark:border-green-700";
      case "pending_auth":
        return "bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 border-yellow-200 dark:border-yellow-700";
      case "syncing":
        return "bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-700";
      case "error":
        return "bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 border-red-200 dark:border-red-700";
      case "inactive":
        return "bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 border-gray-200 dark:border-gray-600";
      case "pending_sync":
        return "bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 border-purple-200 dark:border-purple-700";
      default:
        return "bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 border-gray-200 dark:border-gray-600";
    }
  };

  const getAuthMethodColor = (method: string) => {
    switch (method) {
      case "direct":
        return "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300";
      case "oauth_browser":
      case "oauth_token":
      case "oauth_byoc":
        return "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300";
      case "auth_provider":
        return "bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300";
      default:
        return "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300";
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100">
          Source Connections
          {connections && (
            <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">({connections.length})</span>
          )}
        </h2>
        <p className="mt-1 text-gray-600 dark:text-gray-400">Active source connections in your collections</p>
      </div>

      {/* Filters */}
      <div className="mb-6 rounded-xl bg-white dark:bg-gray-800 p-6 shadow-lg">
        <h3 className="mb-4 text-lg font-semibold text-gray-800 dark:text-gray-100">Filters</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* Collection Filter */}
          <div>
            <label
              htmlFor="filter-collection"
              className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >
              Collection
            </label>
            <select
              id="filter-collection"
              value={selectedCollection}
              onChange={(e) => setSelectedCollection(e.target.value)}
              className="w-full cursor-pointer rounded-lg border-2 border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-4 py-2 text-base transition-all focus:border-green-500 dark:focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-200 dark:focus:ring-green-900"
            >
              <option value="">All Collections</option>
              {collections?.map((col: { id: string; readable_id: string; name: string }) => (
                <option key={col.id} value={col.readable_id}>
                  {col.name}
                </option>
              ))}
            </select>
          </div>

          {/* Skip */}
          <div>
            <label htmlFor="filter-skip" className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300">
              Skip
            </label>
            <input
              id="filter-skip"
              type="number"
              min="0"
              value={skip}
              onChange={(e) => setSkip(Number(e.target.value))}
              className="w-full rounded-lg border-2 border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-4 py-2 text-base transition-all focus:border-green-500 dark:focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-200 dark:focus:ring-green-900"
            />
          </div>

          {/* Limit */}
          <div>
            <label
              htmlFor="filter-limit"
              className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >
              Limit
            </label>
            <input
              id="filter-limit"
              type="number"
              min="1"
              max="100"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-full rounded-lg border-2 border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-4 py-2 text-base transition-all focus:border-green-500 dark:focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-200 dark:focus:ring-green-900"
            />
          </div>
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-pulse text-lg font-medium text-green-600">
            Loading source connections...
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-red-700 dark:text-red-400">
          <strong className="font-semibold">Error loading source connections:</strong>{" "}
          {error.message}
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && (!connections || connections.length === 0) && (
        <div className="rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 py-12 text-center">
          <p className="text-lg text-gray-500 dark:text-gray-400">No source connections found.</p>
        </div>
      )}

      {/* Connections List */}
      {!loading && !error && connections && connections.length > 0 && (
        <div className="space-y-4">
          {connections.map(
            (connection: {
              id: string;
              name: string;
              short_name: string;
              readable_collection_id: string;
              created_at: string;
              status: string;
              auth_method: string;
              is_authenticated: boolean;
              entity_count?: number;
            }) => (
              <div
                key={connection.id}
                className="rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 transition-all hover:border-green-500 dark:hover:border-green-400"
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  {/* Left side - Main info */}
                  <div className="flex-1">
                    <div className="mb-2 flex items-start gap-3">
                      <div className="flex-1">
                        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100">{connection.name}</h3>
                        <p className="font-mono text-sm text-gray-500 dark:text-gray-400">{connection.short_name}</p>
                      </div>

                      {/* Status Badge */}
                      <span
                        className={`rounded-full border px-3 py-1 text-xs font-semibold ${getStatusColor(connection.status)}`}
                      >
                        {connection.status}
                      </span>
                    </div>

                    {/* Collection */}
                    <div className="mb-3">
                      <span className="text-sm text-gray-600 dark:text-gray-400">
                        Collection:{" "}
                        <span className="font-mono text-gray-800 dark:text-gray-200">
                          {connection.readable_collection_id}
                        </span>
                      </span>
                    </div>

                    {/* Metadata Grid */}
                    <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                      {/* Auth Method */}
                      <div>
                        <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Authentication</p>
                        <span
                          className={`inline-block rounded px-2 py-1 text-xs font-medium ${getAuthMethodColor(connection.auth_method)}`}
                        >
                          {connection.auth_method}
                        </span>
                      </div>

                      {/* Authenticated Status */}
                      <div>
                        <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Status</p>
                        <span className="text-sm font-medium">
                          {connection.is_authenticated ? (
                            <span className="text-green-600 dark:text-green-400">✓ Authenticated</span>
                          ) : (
                            <span className="text-red-600 dark:text-red-400">✗ Not Authenticated</span>
                          )}
                        </span>
                      </div>

                      {/* Entity Count */}
                      {connection.entity_count !== undefined && (
                        <div>
                          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Entities</p>
                          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                            {connection.entity_count.toLocaleString()}
                          </span>
                        </div>
                      )}

                      {/* Timestamps */}
                      <div>
                        <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Created</p>
                        <span className="text-xs text-gray-600 dark:text-gray-400">
                          {new Date(connection.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
