# Airweave Fragment

Integrate Airweave's AI-powered search and semantic analysis directly into your own application,
built with [Fragno](https://fragno.dev/).

## Installation

Install the Airweave fragment:

**npm**

```bash
npm install @fragno-dev/airweave-fragment
```

## Usage

### Step 1: Create a server-side instance

Create a server-side instance of the Fragment in a central location in your codebase. This is where
you configure the Fragment with your Airweave API credentials.

```ts
// lib/airweave-server.ts
import { createAirweaveFragment } from "@fragno-dev/airweave-fragment";

export const airweaveFragment = createAirweaveFragment({
  apiKey: process.env.AIRWEAVE_API_KEY,
  baseUrl: process.env.AIRWEAVE_BASE_URL,
});
```

### Step 2: Mount the API routes

Mount the Fragment’s API routes into your application. Fragno works with many
[frameworks](https://fragno.dev/docs/frameworks) out of the box and follows a simple
`Request`/`Response` model, making it easy to integrate with nearly any framework.

Example for React Router v7:

```ts
// routes/api.airweave-fragment.$.tsx
import { airweaveFragment } from "~/lib/airweave-server";

const handlers = airweaveFragment.handlersFor("react-router");

export const loader = handlers.loader;
export const action = handlers.action;
```

### Step 3: Create the Client

Create the client-side integration in a central location, import the client for your specific
framework.

```ts
// lib/airweave-client.ts
import { createAirweaveFragmentClient } from "@fragno-dev/airweave-fragment/react";

// Export the hooks you want to use
export const { useSearch, useCollections } = createAirweaveFragmentClient();
```

> **Important:** Make sure the file name does **not** end with `.client.ts`. In some frameworks,
> this prevents the file from being loaded on the server during server-side rendering.

> **Custom Mount Route:** If you mounted the backend routes on a different path, pass the
> `mountRoute` option to the client initialization.

### Step 4: Use in your components

You can now use the Airweave hooks in any of your components:

```tsx
// components/SearchComponent.tsx
import { useState } from "react";
import { useSearch, useCollections } from "~/lib/airweave-client";

export default function SearchComponent() {
  const [query, setQuery] = useState("");
  const [selectedCollection, setSelectedCollection] = useState("");

  // Get available collections
  const {
    data: collections,
    loading: collectionsLoading,
    error: collectionsError,
  } = useCollections();

  // Perform search
  const { data: searchResults, loading: searching, error: searchError, mutate } = useSearch();

  const handleSearch = () => {
    if (!query.trim() || !selectedCollection) return;

    mutate({
      path: { collectionId: selectedCollection },
      body: {
        query: query.trim(),
        generate_answer: true,
        retrieval_strategy: "hybrid",
        rerank: true,
      },
    });
  };

  return (
    <div>
      <h1>AI-Powered Search</h1>

      {/* Collection Selector */}
      {collections && (
        <select value={selectedCollection} onChange={(e) => setSelectedCollection(e.target.value)}>
          <option value="">Select a collection...</option>
          {collections.map((col) => (
            <option key={col.id} value={col.readable_id}>
              {col.name}
            </option>
          ))}
        </select>
      )}

      {/* Search Input */}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Enter your search query..."
      />

      <button onClick={handleSearch} disabled={!query.trim() || searching}>
        {searching ? "Searching..." : "Search"}
      </button>

      {/* Error Display */}
      {searchError && <div>Error: {searchError.message}</div>}

      {/* Results */}
      {searchResults?.results && (
        <div>
          {searchResults.results.map((result) => (
            <div key={result.id}>
              <h3>{result.title}</h3>
              <p>{result.content}</p>
            </div>
          ))}
        </div>
      )}

      {/* AI-Generated Answer */}
      {searchResults?.completion && (
        <div>
          <h2>AI Answer</h2>
          <p>{searchResults.completion}</p>
        </div>
      )}
    </div>
  );
}
```
