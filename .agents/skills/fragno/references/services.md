# Services

## Overview

Services are functions exposed by Fragment authors to users. They are designed to be called on the
server, such as in loader functions or background processing.

## Basic Usage

The `services` object is available on the Fragment's server-side instance:

```typescript
import { createExampleFragmentInstance } from "../lib/example-fragment-server";

export async function myBackgroundProcess() {
  const { getHashFromHostsFileData } = createExampleFragmentInstance().services;

  setInterval(
    () => {
      const hash = getHashFromHostsFileData();
      console.log("Hash of hosts file:", hash);
    },
    1000 * 60 * 60, // every hour
  );
}
```

## Calling Route Handlers Directly

Use route calls instead of services when you need:

- Access to response headers (cookies, custom headers, etc.)
- Full control over the HTTP response
- To call routes from server actions/loaders

### API Reference

```typescript
fragment.callRoute(method, path, options?): Promise<FragnoResponse<TOutput>>
fragment.callRouteRaw(method, path, options?): Promise<Response>
```

**Parameters:**

- `method`: HTTP method (`"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, `"PATCH"`, `"HEAD"`, `"OPTIONS"`)
- `path`: Route path (e.g., `"/sign-in"`, `"/users/:id"`)
- `options`: Optional parameters
  - `body`: Request body (for POST, PUT, PATCH, DELETE requests)
  - `pathParams`: Path parameters (e.g., `{ id: "123" }` for `/users/:id`)
  - `query`: Query parameters as object or URLSearchParams
  - `headers`: Request headers as object or Headers

**Returns:**

- `callRoute()`: a `Promise<FragnoResponse<T>>` (discriminated union:
  `"json" | "jsonStream" | "empty" | "error"`)
- `callRouteRaw()`: a `Promise<Response>` (raw fetch response, for forwarding headers/cookies)

**Type Safety:** The method and path parameters are strongly typed based on the fragment's available
routes.

**Note:** Unlike services, both `callRoute()` and `callRouteRaw()` validate input using the route's
schema. Use `callRoute()` for a parsed, typed result; use `callRouteRaw()` when you need the raw
`Response` (headers/cookies/streaming control).

### Example: React Router / Remix

```typescript
import { authFragment } from "../lib/auth-fragment-server";

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();

  // Use callRouteRaw() when you want to return a real Response (with headers)
  const response = await authFragment.callRouteRaw("POST", "/sign-in", {
    body: {
      email: formData.get("email") as string,
      password: formData.get("password") as string,
    },
  });

  return response; // Includes headers set by the fragment (e.g., Set-Cookie)
}
```
