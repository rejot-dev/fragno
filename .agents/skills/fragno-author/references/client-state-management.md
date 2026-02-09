# Client-side State Management - distilled

Source: Fragno Docs — Client-side State Management

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/features/client-state-management" -H "accept: text/markdown"`

## Core idea

- Fragno uses Nanostores under the hood to provide reactive client hooks for multiple frameworks.
- Start with `createClientBuilder(definition, publicConfig, routes)`.

## Reading data

- `createHook(path, options?)` for GET-style routes.
- Options include `transform`, `refetchInterval`, and `enabled`.
- The hook returns `{ data, loading, error }`; params are reactive.
- Streaming responses update `data` incrementally after the first item.

## Mutations

- `createMutator(method, path, onInvalidate?)` for write routes.
- Default invalidation invalidates the matching GET route; override when needed.
- `mutate(...)` returns data; `loading` is undefined until mutation starts.

## Advanced patterns

- Use Nanostores (`computed`, `atom`, `effect`) for derived or custom state.
- Wrap custom stores with `builder.createStore(...)` to make them framework-reactive.
- Objects passed to `createStore` have top-level fields made reactive; functions stay plain.

## Custom fetcher

- Pass a 4th argument to `createClientBuilder`:
  - `{ type: "options", options: RequestInit }` for default fetch options
  - `{ type: "function", fetcher }` for a custom fetch function
- User config takes precedence and deep-merges options.
- Use `buildUrl()` and `getFetcher()` for custom requests.
