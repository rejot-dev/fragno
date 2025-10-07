# AGENTS.md

This file provides guidance for AI agents working with Fragno fragments. It contains architectural
information, development strategies, and practical approaches for building fragments.

## Overview

A **Fragment** is a full-stack, framework-agnostic TypeScript library built with Fragno. Fragments
provide:

- Type-safe server-side API routes
- Automatic client-side hooks/composables for multiple frameworks (React, Vue, Svelte, Vanilla JS)
- Automatic code splitting between client and server bundles
- Built-in state management with reactive stores (TanStack Query-style:
  `const {data, loading, error} = useData()`)

**Documentation**: Full documentation is available at https://fragno.dev/docs

## Architecture

Fragments follow a core pattern:

1. **Server-side**: Define routes with input/output schemas, handlers, and dependencies
2. **Client-side**: Auto-generated type-safe hooks for each route
3. **Code splitting**: Server-only code (handlers, dependencies) is stripped from client bundles

## File Structure & Core Concepts

### `src/index.ts` - Main Fragment Definition

This is the core file that contains the fragment definition, routes, dependencies, services, and
client builder.

**Key concepts defined in this file**:

**Fragment Definition** (`defineFragment`):

- Takes a config type parameter that defines what users must provide (API keys, callbacks, etc.)
- The fragment name is used in the URL path: `/api/<fragment-name>/...`

**Dependencies** (`.withDependencies()`):

- Server-side only (never included in client bundle)
- Private to the fragment, not accessible to users
- Access to config for initialization (e.g., API keys, database connections)
- Used in route handlers

**Services** (`.withServices()`):

- Server-side only (never included in client bundle)
- Public-facing API accessible to users via `fragment.services.methodName()`
- Access to both config and dependencies
- Useful for exposing utility methods to users

**Route Definition** (`defineRoute` and `defineRoutes`):

- `defineRoute`: Simple routes without dependencies
- `defineRoutes`: Route factory that has access to dependencies and services
- Route handler context:
  - First parameter (input): `{ input, query, pathParams, request, url }`
  - Second parameter (output): `{ json, jsonStream, empty, error }`
  - `input.valid()` validates and returns parsed data (throws on validation error)

**Server-Side Fragment** (`createFragment`):

- Users call this function to instantiate the fragment on the server
- Returns an object with request handlers (`handler(request: Request) => Response`) and `services`

**Client-Side Builder** (`createClientBuilder`):

- Creates type-safe hooks for each route
- `createHook(path)`: For GET routes (returns `{ data, loading, error }`)
- `createMutator(method, path)`: For POST/PUT/PATCH/DELETE routes (returns
  `{ data, loading, error, mutate }`)
- Advanced: Use `computed`, `atom` from `nanostores` for derived state

### `src/client/*.ts` - Framework-Specific Exports

Each framework requires a separate client file that wraps the generic client builder with the
framework-specific `useFragno` hook. Check the `src/client/` directory for existing framework
implementations. Use the frameworks page on https://fragno.dev/docs/frameworks to see if all clients
have their stubs defined. Make sure to include new frameworks in the exports section of
package.json.

### `package.json` - Package Configuration

The package.json defines multiple export paths for different frameworks and environments. Key
points:

- Main export (`.`) is server-side code
- Framework exports (`./react`, `./vue`, `./svelte`, `./vanilla`) use "browser" condition to load
  client bundle
- Development mode uses source files for better debugging
- Production uses built files from `dist/`
- When adding new framework exports, add corresponding client files in `src/client/`

## Strategies for Building Fragments

### OpenAPI/Swagger Spec → Fragno Routes

Parse an OpenAPI specification and convert it to Fragno routes. Map HTTP methods to `defineRoute`,
convert path parameters (e.g., `/users/{id}` → `/users/:id`), convert JSON schemas to Zod schemas
for `inputSchema`/`outputSchema`, and generate handlers. Group related routes using `defineRoutes`
if they share dependencies. Extract error codes from OpenAPI error responses.

### REST API Wrapper

Wrap an existing REST API with proper typing and error handling. Add HTTP client (fetch, axios) to
dependencies with API credentials from config. Create routes that proxy to API endpoints with proper
error handling and validation. Optionally add caching or rate limiting in services. This approach is
useful when you want to provide a type-safe interface to an existing API.

### Third-Party SDK Integration

Wrap third-party SDKs (Stripe, OpenAI, Twilio, etc.) as fragments. Add SDK to dependencies with API
keys from config. Create routes that expose SDK functionality, transform SDK responses to match your
schemas, and handle SDK-specific errors and rate limits. Optionally expose the SDK client directly
in services for advanced users. Use streaming responses for real-time SDK features like AI chat.

## Development Workflow

### Building

Fragments require code splitting between client and server bundles using
`@fragno-dev/unplugin-fragno`. The plugin can also be imported for different kinds of build tools:
`/esbuild`, `/rollup`, `/webpack`, `/rspack`, `/farm`.

### Type Checking

```bash
bun run types:check
```

## Common Patterns

### Streaming Responses

For real-time data (e.g., AI chat, large datasets), use `jsonStream` with `stream.write()` and
`stream.sleep()`. The output schema must be an array. Client-side: The `data` array is updated
reactively as chunks arrive.

### Error Handling

- Always define `errorCodes` array in route definition
- Use structured errors: `error({ message: string, code: string }, statusCode)`
- `input.valid()` automatically throws validation errors (converted to 400 responses)
- Check for null/undefined before processing and return appropriate error codes

### Create Callbacks

Allow users to react to events by including optional callback functions in your config:

```typescript
interface FragmentConfig {
  onDataCreated?: (data: Data) => void;
  onError?: (error: Error) => void;
}
```

Call them in handlers after operations complete: `config.onDataCreated?.(data);`

## Using Your Fragment in Other Projects

Once you've built and published your fragment, users can integrate it into their projects. The
integration has two parts:

### 1. Server-Side Setup

Create a server instance of your fragment (e.g., in `lib/fragment-server.ts`):

```typescript
import { createFragment } from "your-fragment-name";

export const createFragmentInstance = () =>
  createFragment({
    // Fragment-specific configuration here
    apiKey: process.env.API_KEY,
  });
```

Then mount it as a route handler. For example, in Next.js:

```typescript
// app/api/your-fragment/[...all]/route.ts
import { createFragmentInstance } from "@/lib/fragment-server";

const fragment = createFragmentInstance();
export const { GET, POST, PUT, PATCH, DELETE } = fragment.handlersFor("next-js");
```

### 2. Client-Side Setup

Initialize the client in your app (e.g., React):

```typescript
// lib/fragment-client.ts
import { createFragmentClient } from "your-fragment-name/react";

export const { useData, useMutateData } = createFragmentClient({
  // Optional Fragno configuration
  baseUrl: "/",
  mountRoute: "/api/your-fragment",
});
```

Then use the generated hooks in your components:

```tsx
import { useData } from "@/lib/fragment-client";

function MyComponent() {
  const { data, loading, error } = useData({
    /* input */
  });

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  return <div>{JSON.stringify(data)}</div>;
}
```
