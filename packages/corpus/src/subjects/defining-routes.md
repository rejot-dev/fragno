# Defining Routes

Routes are the core of a Fragno fragment, defining HTTP endpoints that handle requests and return
responses. This guide covers the essential patterns for defining routes.

```typescript @fragno-imports
import { defineRoute, defineRoutes, defineFragment, createFragment } from "@fragno-dev/core";
import type { FragnoPublicConfig } from "@fragno-dev/core";
import { z } from "zod";
```

## Basic GET Route

A simple GET route with an output schema.

```typescript @fragno-test
// should define a basic GET route
const basicGetRoute = defineRoute({
  method: "GET",
  path: "/hello",
  outputSchema: z.string(),
  handler: async (_, { json }) => {
    return json("Hello, World!");
  },
});

expect(basicGetRoute.method).toBe("GET");
expect(basicGetRoute.path).toBe("/hello");
```

The `outputSchema` uses Zod (or any Standard Schema compatible library) to define the response type.
The handler receives a context object and helpers like `json()` for sending responses.

## POST Route with Input Schema

Routes can accept and validate request bodies using `inputSchema`.

```typescript @fragno-test
// should define a POST route with input schema
const createItemRoute = defineRoute({
  method: "POST",
  path: "/items",
  inputSchema: z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
  }),
  handler: async ({ input }, { json }) => {
    const data = await input.valid();

    return json({
      id: "item-123",
      name: data.name,
      description: data.description,
    });
  },
});

expect(createItemRoute.method).toBe("POST");
expect(createItemRoute.inputSchema).toBeDefined();
```

The `input.valid()` method validates the request body against the schema and returns the typed data.

## Query Parameters

Routes can declare query parameters they expect to receive.

```typescript @fragno-test
// should define a route with query parameters
const listItemsRoute = defineRoute({
  method: "GET",
  path: "/items",
  queryParameters: ["page", "limit", "filter"],
  outputSchema: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
  handler: async ({ query }, { json }) => {
    const page = query.get("page") || "1";
    const limit = query.get("limit") || "10";
    const filter = query.get("filter");

    return json([
      { id: "1", name: "Item 1" },
      { id: "2", name: "Item 2" },
    ]);
  },
});

expect(listItemsRoute.queryParameters).toEqual(["page", "limit", "filter"]);
```

Query parameters are accessed via `query.get(name)` from the context.

## Error Handling

Routes can define custom error codes and return errors with appropriate status codes.

```typescript @fragno-test
// should define a route with error codes
const validateItemRoute = defineRoute({
  method: "POST",
  path: "/validate",
  inputSchema: z.object({
    value: z.string(),
  }),
  outputSchema: z.object({ valid: z.boolean() }),
  errorCodes: ["INVALID_VALUE", "VALUE_TOO_SHORT"],
  handler: async ({ input }, { json, error }) => {
    const data = await input.valid();

    if (data.value.length < 3) {
      return error(
        {
          message: "Value must be at least 3 characters",
          code: "VALUE_TOO_SHORT",
        },
        400,
      );
    }

    if (!/^[a-z]+$/.test(data.value)) {
      return error(
        {
          message: "Value must contain only lowercase letters",
          code: "INVALID_VALUE",
        },
        400,
      );
    }

    return json({ valid: true });
  },
});

expect(validateItemRoute.errorCodes).toEqual(["INVALID_VALUE", "VALUE_TOO_SHORT"]);
```

The `error()` helper sends an error response with a custom error code and HTTP status.

## Using Dependencies

Routes can access dependencies defined in `withDependencies` through route factories.

```typescript
interface AppConfig {
  apiKey: string;
}

interface AppDeps {
  config: AppConfig;
  timestamp: number;
}

export const routesWithDeps = defineRoutes<AppConfig, AppDeps>().create(({ deps }) => {
  return [
    defineRoute({
      method: "GET",
      path: "/config-info",
      outputSchema: z.object({
        hasApiKey: z.boolean(),
        timestamp: z.number(),
      }),
      handler: async (_, { json }) => {
        return json({
          hasApiKey: !!deps.config.apiKey,
          timestamp: deps.timestamp,
        });
      },
    }),
  ];
});
```

Dependencies are passed to the route factory function and can be used in route handlers.

## Using Services

Services defined in `withServices` can be used in routes for business logic.

```typescript
interface DataService {
  getData: () => string;
  processData: (input: string) => Promise<string>;
}

export const routesWithServices = defineRoutes<{}, {}, DataService>().create(({ services }) => {
  return [
    defineRoute({
      method: "GET",
      path: "/data",
      outputSchema: z.string(),
      handler: async (_, { json }) => {
        const data = services.getData();
        return json(data);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/process",
      inputSchema: z.object({ input: z.string() }),
      outputSchema: z.string(),
      handler: async ({ input }, { json }) => {
        const { input: inputData } = await input.valid();
        const result = await services.processData(inputData);
        return json(result);
      },
    }),
  ];
});
```

Services provide reusable business logic that can be shared across multiple routes.

## Complete Fragment Example

A complete example showing how routes integrate with fragment definition.

```typescript
interface MyFragmentConfig {
  apiKey: string;
}

interface MyFragmentDeps {
  config: MyFragmentConfig;
}

interface MyFragmentServices {
  getStatus: () => string;
}

const myFragmentDefinition = defineFragment<MyFragmentConfig>("my-fragment")
  .withDependencies(({ config }) => {
    return {
      config,
    };
  })
  .withServices(({ deps }) => {
    return {
      getStatus: () => `API Key: ${deps.config.apiKey.substring(0, 3)}...`,
    };
  });

const myRoutes = defineRoutes<MyFragmentConfig, MyFragmentDeps, MyFragmentServices>().create(
  ({ services }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/status",
        outputSchema: z.string(),
        handler: async (_, { json }) => {
          return json(services.getStatus());
        },
      }),
    ];
  },
);

export function createMyFragment(config: MyFragmentConfig, options: FragnoPublicConfig = {}) {
  return createFragment(myFragmentDefinition, config, [myRoutes], options);
}
```

This example shows the complete flow: fragment definition with dependencies and services, route
factory using those services, and the fragment creation function.
