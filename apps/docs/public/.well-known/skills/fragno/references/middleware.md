# Middleware

## Overview

Middleware intercepts and processes requests before they reach route handlers. Use for
authentication, rate limiting, and selectively disabling routes. Fully type-safe with access to
request body, path parameters, query parameters, etc.

## Basic Usage

Middleware is defined as part of the Fragment's server configuration. It is called for every request
and can modify the request before it reaches the route handlers. Fragno only supports a single
middleware method.

Returning `undefined` (or void) will continue the request to the route handler. Returning a Response
will short-circuit the request and return the Response.

```typescript
import { createExampleFragment } from "@fragno-dev/example-fragment";

export function createExampleFragmentInstance() {
  return createExampleFragment({
    someApiKey: process.env.EXAMPLE_API_KEY!,
  }).withMiddleware(async ({ queryParams, path, method }, { error, json }) => {
    const q = queryParams.get("q");
    if (q === "secret") {
      return undefined; // Continue to route handler
    }
    return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
  });
}
```

## Route-specific Usage

`ifMatchesRoute` executes middleware only for specific routes with full type safety for parameters
and request input:

```typescript
export function createExampleFragmentInstance() {
  return createExampleFragment({}).withMiddleware(async ({ ifMatchesRoute }) => {
    const createResponse = await ifMatchesRoute("POST", "/users", async ({ input }) => {
      const body = await input.valid();
      logger.log(`Creating user with ID: ${body.id}`);
    });

    const deleteResponse = await ifMatchesRoute("DELETE", "/users/:id", async () => {
      return error(
        { message: "Deleting users has been disabled.", code: "DELETE_USERS_DISABLED" },
        403,
      );
    });

    if (deleteResponse) {
      return deleteResponse; // Must return the response from ifMatchesRoute
    }
  });
}
```

## Modifying Requests

Middleware can modify requests before they reach route handlers, including query parameters, path
parameters, request body, and headers:

```typescript
export function createExampleFragmentInstance() {
  return createExampleFragment({}).withMiddleware(async ({ ifMatchesRoute, requestState }) => {
    await ifMatchesRoute("POST", "/users/:id", async ({ query, pathParams, input, headers }) => {
      query.set("role", "admin");
      pathParams.id = pathParams.id.toLowerCase();
      headers.set("X-Custom-Header", "middleware-value");

      const body = await input.valid();
      requestState.setBody({
        ...body,
        createdBy: "system",
        timestamp: Date.now(),
      });
    });
  });
}
```
