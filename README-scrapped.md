### 2. Use on the Server

#### Node.js / Express

```typescript
import { toNodeHandler } from "@fragno-dev/node";
import { createTodos } from "./my-fragment";

const todos = createTodos({}, { mountRoute: "/api/todos" });
app.use("/api/todos", toNodeHandler(todos.handler));
```

#### React Router

```typescript
// app/routes/api.todos.tsx
import { createTodos } from "./my-fragment";

export async function loader({ request }) {
  const todos = createTodos();
  return await todos.handler(request);
}

export async function action({ request }) {
  const todos = createTodos();
  return await todos.handler(request);
}
```

### 3. Use on the Client

#### React

```typescript
import { createTodosClient } from "./my-fragment";
import { useFragno } from "@fragno-dev/core/react";

const todosClient = createTodosClient({
  baseUrl: "http://localhost:3000",
  mountRoute: "/api/todos"
});

const { useTodos, addTodo } = useFragno(todosClient);

function TodoApp() {
  const { data: todos, loading } = useTodos();
  const { mutate: addTodo } = addTodo();

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      {todos?.map(todo => (
        <div key={todo.id}>{todo.text}</div>
      ))}
      <button onClick={() => addTodo({ body: { text: "New todo" } })}>
        Add Todo
      </button>
    </div>
  );
}
```

#### Vue

```typescript
import { createTodosClient } from "./my-fragment";
import { useFragno } from "@fragno-dev/core/vue";

const todosClient = createTodosClient({
  baseUrl: "http://localhost:3000",
  mountRoute: "/api/todos",
});

const { useTodos, addTodo } = useFragno(todosClient);

// In your component
const todos = useTodos();
const { mutate: addTodo } = addTodo();
```

## Code Splitting

Fragno automatically splits your code between client and server bundles using
`@fragno-dev/unplugin-fragno`:

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import fragno from "@fragno-dev/unplugin-fragno/vite";

export default defineConfig({
  plugins: [fragno()],
});
```

Server-side dependencies defined in `withDependencies` are automatically removed from client
bundles:

```typescript
// This entire dependencies factory is stripped from client bundles
const myLibDefinition = defineLibrary("my-lib").withDependencies((config) => {
  return {
    database: new DatabaseConnection(),
    secretKey: process.env.SECRET_KEY,
  };
});

// Client bundle only gets route definitions, not the server implementation
export function createMyLibrary(serverConfig = {}, fragnoConfig = {}) {
  return createLibrary(myLibDefinition, serverConfig, routes, fragnoConfig);
}
```

## Advanced Features

### Streaming Responses

```typescript
const streamRoute = defineRoute({
  method: "GET",
  path: "/stream",
  outputSchema: z.array(z.object({ message: z.string() })),
  handler: async (_, { jsonStream }) => {
    return jsonStream(async (stream) => {
      for (let i = 0; i < 10; i++) {
        await stream.write({ message: `Item ${i}` });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  },
});
```

### Path Parameters

```typescript
const getUserRoute = defineRoute({
  method: "GET",
  path: "/users/:id",
  pathSchema: z.object({ id: z.string() }),
  handler: async ({ path }, { json }) => {
    const { id } = await path.valid();
    // Use typed id parameter
    return json({ userId: id });
  },
});
```

### Error Handling

```typescript
const protectedRoute = defineRoute({
  method: "POST",
  path: "/protected",
  errorCodes: ["UNAUTHORIZED", "FORBIDDEN"] as const,
  handler: async (_, { error, json }) => {
    if (!authorized) {
      return error(
        {
          message: "Login required",
          code: "UNAUTHORIZED",
        },
        401,
      );
    }
    return json({ success: true });
  },
});
```

### Middleware

Add middleware to intercept and process requests before they reach your route handlers:

```typescript
const library = defineLibrary<Config>("my-api").withServices((config) => ({
  auth: {
    isAuthorized: (token?: string) => token === config.apiKey,
  },
  logger: {
    log: (msg: string) => console.log(msg),
  },
}));

const instance = createLibrary(library, config, routes).withMiddleware(
  async (context, { deps, services }) => {
    const { method, path, queryParams, pathParams } = context;

    // Log request
    services.logger.log(`${method} ${path}`);

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Check authentication
    const authToken = queryParams.get("token");
    if (!services.auth.isAuthorized(authToken ?? undefined)) {
      return Response.json({ message: "Unauthorized", code: "AUTH_ERROR" }, { status: 401 });
    }

    // Route-specific middleware using ifMatchesRoute
    const result = await context.ifMatchesRoute("POST", "/users/:id", async ({ pathParams }) => {
      // This middleware only runs for POST requests to /users/:id

      // pathParams is strongly typed
      services.logger.log(`Creating user with ID: ${pathParams.id}`);

      // Return undefined to continue to the original handler
      return undefined;
    });

    if (result) {
      return result;
    }

    // Return undefined to continue to handler
    return undefined;
  },
);
```

Middleware receives:

- **`context`**: Request context with:
  - **`method`**: HTTP method
  - **`path`**: Request path
  - **`pathParams`**: Extracted path parameters
  - **`queryParams`**: URL search parameters
  - **`inputSchema`**: Route's input schema
  - **`outputSchema`**: Route's output schema
  - **`ifMatchesRoute()`**: Execute middleware only for specific routes with full type safety
- **`deps`**: Library dependencies
- **`services`**: Library services

The `ifMatchesRoute` method allows you to write route-specific middleware with full TypeScript
support for path parameters and request/response schemas.

Return a Response to short-circuit, or `undefined` to continue to the handler.
